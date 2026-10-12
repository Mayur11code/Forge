// src/tests/workflow/workflow-proposal-compiler.test.ts
//
// Assignment 37.4 — deterministic proposal compiler.
//
// The compiler composes four existing layers (structure, references, mapping,
// graph collector) into one boundary. These tests prove three things beyond the
// happy path:
//
//   1. ORDER. A failure at an earlier stage short-circuits later stages, so a
//      caller is never shown a downstream symptom of an upstream error.
//   2. DETERMINISM. No clock, no mutation, identical output for identical input.
//   3. STRUCTURE. Expected failures are typed `ProposalIssue[]` with the
//      collector's `code` and `message` intact; graph paths are never smuggled
//      into `ProposalIssue.path`.
//
// The normalization adapter is asserted over ALL seven collector codes even
// though only three are reachable through a proposal, because the adapter's
// contract must be total: the other four are directly exercised by
// `dag-validation.test.ts` at the collector level.

import fs from "fs";
import path from "path";

import {
  PROPOSAL_DEFINITION_ID,
  PROPOSAL_DEFINITION_NAME,
  compileWorkflowProposal,
  mapProposalToDefinition,
  toProposalIssues,
} from "@/lib/workflow-types/workflow-proposal-compiler";
import {
  collectWorkflowDefinitionIssues,
  type WorkflowDefinitionIssue,
} from "@/lib/workflow-types/workflow";
import type { ProposalIssue } from "@/lib/workflow-types/workflow-proposal";

const FORGE_ROOT = path.resolve(__dirname, "../../..");

function step(overrides: Record<string, unknown> = {}) {
  return {
    action: "task.create",
    inputs: {
      title: "Create the onboarding task",
      projectId: "clxyz0000000000000000000a",
    },
    dependsOn: [] as string[],
    ...overrides,
  };
}

function proposal(steps: Record<string, unknown>) {
  return { name: "Generated", steps };
}

function issuesOf(
  result: ReturnType<typeof compileWorkflowProposal>,
): ProposalIssue[] {
  if (result.success) throw new Error("expected compilation to fail");
  return result.issues;
}

function codes(issues: ProposalIssue[]) {
  return issues.map((issue) => issue.code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pipeline and result contract
// ---------------------------------------------------------------------------

describe("compileWorkflowProposal - result contract", () => {
  it("compiles a valid proposal into a definition", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.definition.steps)).toEqual(["a", "b"]);
    }
  });

  it("returns structured issues, not a thrown error, for a structural failure", () => {
    const result = compileWorkflowProposal({ name: "Empty", steps: {} });

    expect(result.success).toBe(false);
    expect(codes(issuesOf(result))).toEqual(["EMPTY_PROPOSAL"]);
  });

  it("runs reference validation on a valid proposal and reports its issues", () => {
    const result = compileWorkflowProposal(
      proposal({
        a: step({
          inputs: {
            title: "Create the onboarding task",
            projectId: "{{ghost.outputs.projectId}}",
          },
        }),
      }),
    );

    expect(codes(issuesOf(result))).toContain("UNKNOWN_REFERENCE_SOURCE");
  });

  it("short-circuits before the graph collector when references fail", () => {
    // The two steps form a cycle, so the collector WOULD emit CYCLE if it ran.
    // A reference failure at stage 2 must prevent that.
    const result = compileWorkflowProposal(
      proposal({
        a: step({
          inputs: {
            title: "Create the onboarding task",
            projectId: "{{ghost.outputs.projectId}}",
          },
          dependsOn: ["b"],
        }),
        b: step({ dependsOn: ["a"] }),
      }),
    );

    const issueCodes = codes(issuesOf(result));
    expect(issueCodes).toContain("UNKNOWN_REFERENCE_SOURCE");
    expect(issueCodes).not.toContain("CYCLE");
  });

  it("returns EMPTY_PROPOSAL, never EMPTY_GRAPH, for an empty proposal", () => {
    const issueCodes = codes(issuesOf(compileWorkflowProposal({ name: "x", steps: {} })));

    expect(issueCodes).toContain("EMPTY_PROPOSAL");
    expect(issueCodes).not.toContain("EMPTY_GRAPH");
  });

  it("retains proposal metadata alongside the candidate definition", () => {
    const result = compileWorkflowProposal({
      name: "Onboarding",
      description: "What this workflow does.",
      steps: { a: step() },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.proposal.name).toBe("Onboarding");
      expect(result.proposal.description).toBe("What this workflow does.");
      expect(result.definition.id).toBe(PROPOSAL_DEFINITION_ID);
      expect(result.definition.name).toBe(PROPOSAL_DEFINITION_NAME);
      // The human-facing name is proposal metadata, never copied into the
      // definition's placeholder name (F2).
      expect(result.definition.name).not.toBe(result.proposal.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe("mapProposalToDefinition - mapping boundaries", () => {
  it("uses each localRef as both the record key and the step id", () => {
    const result = compileWorkflowProposal(
      proposal({ create_task: step(), send: step({ dependsOn: ["create_task"] }) }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      for (const [key, definitionStep] of Object.entries(result.definition.steps)) {
        expect(definitionStep.id).toBe(key);
      }
      expect(result.definition.steps.create_task.id).toBe("create_task");
    }
  });

  it("maps inputs to config and preserves dependsOn", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );

    if (!result.success) throw new Error("expected success");
    expect(result.definition.steps.a.config).toEqual(step().inputs);
    expect(result.definition.steps.b.dependsOn).toEqual(["a"]);
  });

  it("makes every step an ACTION with provisional isCritical false", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );

    if (!result.success) throw new Error("expected success");
    for (const node of Object.values(result.definition.steps)) {
      expect(node.kind).toBe("ACTION");
      expect(node.isCritical).toBe(false);
    }
  });

  it("never synthesizes a TRIGGER step or routing conditions", () => {
    const result = compileWorkflowProposal(proposal({ a: step() }));

    if (!result.success) throw new Error("expected success");
    const kinds = Object.values(result.definition.steps).map((node) => node.kind);
    expect(kinds).toEqual(["ACTION"]);
    expect(result.definition.steps.a.routingConditions).toBeUndefined();
    expect(result.definition.steps.a.kind).not.toBe("TRIGGER");
  });

  it("does not mutate its input", () => {
    const input = deepFreeze(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );
    const before = JSON.parse(JSON.stringify(input));

    const result = compileWorkflowProposal(input);

    expect(result.success).toBe(true);
    expect(input).toEqual(before);
  });

  it("is deterministic: identical input yields an identical definition", () => {
    const input = proposal({ a: step(), b: step({ dependsOn: ["a"] }) });

    const first = compileWorkflowProposal(input);
    const second = compileWorkflowProposal(input);

    expect(first).toEqual(second);
    if (first.success && second.success) {
      expect(first.definition).toEqual(second.definition);
      expect(first.definition.id).toBe(second.definition.id);
    }
  });

  it("derives no identity from a clock", () => {
    // Behavioral: two compilations separated by real time must produce the same
    // id, and the id must be the documented constant rather than a timestamp.
    const input = proposal({ a: step() });
    const first = compileWorkflowProposal(input);
    const second = compileWorkflowProposal(input);

    if (!first.success || !second.success) throw new Error("expected success");
    expect(first.definition.id).toBe(PROPOSAL_DEFINITION_ID);
    expect(first.definition.id).toBe(second.definition.id);
    expect(first.definition.id).not.toMatch(/\d{10,}/);
  });

  it("uses no clock in the module source", () => {
    const source = fs.readFileSync(
      path.join(
        FORGE_ROOT,
        "src/lib/workflow-types/workflow-proposal-compiler.ts",
      ),
      "utf8",
    );
    expect(source).not.toContain("Date.now");
  });

  it("produces a graph the collector accepts", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );

    if (!result.success) throw new Error("expected success");
    expect(collectWorkflowDefinitionIssues(result.definition)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Graph semantics
// ---------------------------------------------------------------------------

describe("compileWorkflowProposal - graph semantics", () => {
  it("reports a dependency on a step that does not exist", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step({ dependsOn: ["ghost"] }) }),
    );

    const issues = issuesOf(result);
    const issue = issues.find((entry) => entry.code === "UNKNOWN_DEPENDENCY");
    expect(issue?.path).toBe("steps.a.dependsOn");
  });

  it("reports a cycle with a readable sequence in the message and an input path", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step({ dependsOn: ["b"] }), b: step({ dependsOn: ["a"] }) }),
    );

    const issues = issuesOf(result);
    const cycle = issues.find((entry) => entry.code === "CYCLE");
    expect(cycle).toBeDefined();
    expect(cycle?.path).toBe("steps");
    expect(cycle?.message).toMatch(/a -> b -> a/);
    expect(typeof cycle?.path).toBe("string");
  });

  it("preserves the collector's dual report for a self-dependency", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step({ dependsOn: ["a"] }) }),
    );

    const issueCodes = codes(issuesOf(result));
    expect(issueCodes).toContain("SELF_DEPENDENCY");
    expect(issueCodes).toContain("CYCLE");
  });

  it("rejects a backend-owned field the schema does not allow", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step({ isCritical: true }) }),
    );

    expect(codes(issuesOf(result))).toContain("UNKNOWN_STEP_FIELD");
  });
});

// ---------------------------------------------------------------------------
// Issue normalization
// ---------------------------------------------------------------------------

describe("toProposalIssues - total adapter over the collector vocabulary", () => {
  const samples: WorkflowDefinitionIssue[] = [
    { code: "EMPTY_GRAPH", message: "A workflow needs at least one step." },
    { code: "ID_MISMATCH", message: "mismatch", stepId: "a" },
    { code: "DUPLICATE_STEP_ID", message: "duplicate", stepId: "b" },
    { code: "UNKNOWN_DEPENDENCY", message: "unknown", stepId: "c" },
    { code: "SELF_DEPENDENCY", message: "self", stepId: "d" },
    { code: "UNKNOWN_ROUTING_CONDITION", message: "routing", stepId: "e" },
    {
      code: "CYCLE",
      message: "Steps form a cycle: a -> b -> a. A workflow must be a directed acyclic graph.",
      path: ["a", "b", "a"],
    },
  ];

  it("covers all seven collector codes without dropping one", () => {
    const normalized = toProposalIssues(samples);

    expect(normalized).toHaveLength(7);
    expect(normalized.map((issue) => issue.code)).toEqual(
      samples.map((issue) => issue.code),
    );
  });

  it("preserves every code and message verbatim", () => {
    const normalized = toProposalIssues(samples);

    expect(normalized.map((issue) => issue.message)).toEqual(
      samples.map((issue) => issue.message),
    );
  });

  it("maps each code to a dotted input location (never a graph path)", () => {
    const normalized = toProposalIssues(samples);

    expect(normalized.map((issue) => issue.path)).toEqual([
      "steps",
      "steps.a",
      "steps.b",
      "steps.c.dependsOn",
      "steps.d.dependsOn",
      "steps.e.routingConditions",
      "steps",
    ]);
  });

  it("keeps every normalized path a string", () => {
    for (const issue of toProposalIssues(samples)) {
      expect(typeof issue.path).toBe("string");
    }
  });

  it("reports the collector's exact code for a compiler-detected cycle", () => {
    const result = compileWorkflowProposal(
      proposal({ a: step({ dependsOn: ["b"] }), b: step({ dependsOn: ["a"] }) }),
    );

    const cycle = issuesOf(result).find((issue) => issue.code === "CYCLE");
    expect(cycle?.code).toBe("CYCLE");
    expect(cycle?.message).toContain("A workflow must be a directed acyclic graph");
  });
});

// ---------------------------------------------------------------------------
// Direct mapping entry point
// ---------------------------------------------------------------------------

describe("mapProposalToDefinition - direct use", () => {
  it("does not mutate a frozen proposal", () => {
    const validated = compileWorkflowProposal(
      proposal({ a: step(), b: step({ dependsOn: ["a"] }) }),
    );
    if (!validated.success) throw new Error("expected success");

    const frozen = deepFreeze(
      JSON.parse(JSON.stringify(validated.proposal)),
    ) as typeof validated.proposal;
    const snapshot = JSON.parse(JSON.stringify(frozen));

    const definition = mapProposalToDefinition(frozen);

    expect(Object.keys(definition.steps)).toEqual(["a", "b"]);
    expect(frozen).toEqual(snapshot);
    expect(definition.id).toBe(PROPOSAL_DEFINITION_ID);
    expect(definition.name).toBe(PROPOSAL_DEFINITION_NAME);
  });
});
