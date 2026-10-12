// src/tests/workflow/workflow-proposal.test.ts
//
// Assignment 37.2 - WorkflowProposal schema.
//
// The proposal is the typed boundary between model output and everything Forge
// does deterministically, so these tests are as much about what the contract
// REFUSES as what it accepts. Two properties matter most:
//
//   1. Backend-owned fields (ids, coordinates, criticality, tenant identity)
//      cannot be expressed at all, so a model cannot name them.
//   2. Validation is STRUCTURAL. Dependency existence and output-reference
//      resolution are deliberately NOT checked here - that is 37.3/37.4. A
//      structurally-valid proposal may point at a step that does not exist.
//
// The capability catalog is the source of truth for per-action input rules, so
// the input tests assert reuse (a reference is deferred, a literal is still
// checked) rather than re-listing the `task.create` contract.

import fs from "fs";
import path from "path";

import {
  MAX_PROPOSAL_SERIALIZED_LENGTH,
  MAX_PROPOSAL_STEPS,
  PROPOSAL_LOCAL_REF_PATTERN,
  REFERENCE_TEMPLATE_PATTERN,
  WorkflowProposalSchema,
  WorkflowProposalStepSchema,
  isReferenceTemplate,
  validateWorkflowProposal,
  type ProposalIssue,
  type ProposalIssueCode,
  type WorkflowProposal,
} from "@/lib/workflow-types/workflow-proposal";

const FORGE_ROOT = path.resolve(__dirname, "../../..");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(FORGE_ROOT, relative), "utf8");
}

/** Import statements only, so comments mentioning a module do not count. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    specs.push(match[1]);
  }
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((match = bare.exec(source))) {
    specs.push(match[1]);
  }
  return specs;
}

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

function codes(issues: ProposalIssue[]): ProposalIssueCode[] {
  return issues.map((issue) => issue.code);
}

function issuesOf(result: ReturnType<typeof validateWorkflowProposal>): ProposalIssue[] {
  if (result.success) throw new Error("expected validation to fail");
  return result.issues;
}

function expectIssue(
  result: ReturnType<typeof validateWorkflowProposal>,
  code: ProposalIssueCode,
  pathFragment?: string,
): void {
  const issues = issuesOf(result);
  const match = issues.find(
    (issue) => issue.code === code && (!pathFragment || issue.path.includes(pathFragment)),
  );
  expect(match).toBeDefined();
}

describe("WorkflowProposalStepSchema - structural shape", () => {
  it("exposes exactly action, inputs and dependsOn", () => {
    expect(Object.keys(WorkflowProposalStepSchema.shape).sort()).toEqual([
      "action",
      "dependsOn",
      "inputs",
    ]);
  });

  it("has no backend-owned or execution-owned field", () => {
    const keys = Object.keys(WorkflowProposalStepSchema.shape);
    for (const forbidden of [
      "id",
      "kind",
      "config",
      "isCritical",
      "routingConditions",
      "position",
      "coordinates",
      "orgId",
      "userId",
      "workflowId",
      "runId",
      "stepRunId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("is strict, rejecting an unknown step field", () => {
    const parsed = WorkflowProposalStepSchema.safeParse({
      ...step(),
      isCritical: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("requires action, inputs and dependsOn", () => {
    expect(WorkflowProposalStepSchema.safeParse({}).success).toBe(false);
    expect(
      WorkflowProposalStepSchema.safeParse({
        action: "task.create",
        inputs: {},
      }).success,
    ).toBe(false);
    expect(
      WorkflowProposalStepSchema.safeParse({
        action: "task.create",
        dependsOn: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty action id", () => {
    expect(
      WorkflowProposalStepSchema.safeParse(step({ action: "" })).success,
    ).toBe(false);
  });
});

describe("WorkflowProposalSchema - structural shape", () => {
  it("accepts a valid proposal", () => {
    const parsed = WorkflowProposalSchema.safeParse({
      name: "Onboard new users",
      steps: { create: step() },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an optional description and omits it cleanly", () => {
    const withDescription = WorkflowProposalSchema.safeParse({
      name: "Named",
      description: "What this workflow does.",
      steps: { a: step() },
    });
    expect(withDescription.success).toBe(true);
    const withoutDescription = WorkflowProposalSchema.safeParse({
      name: "Named",
      steps: { a: step() },
    });
    expect(withoutDescription.success).toBe(true);
  });

  it("rejects a missing or empty name", () => {
    expect(
      WorkflowProposalSchema.safeParse({ steps: { a: step() } }).success,
    ).toBe(false);
    expect(
      WorkflowProposalSchema.safeParse({ name: "", steps: { a: step() } }).success,
    ).toBe(false);
  });

  it("rejects an unknown proposal field", () => {
    const parsed = WorkflowProposalSchema.safeParse({
      name: "Named",
      steps: { a: step() },
      organizationId: "attacker-controlled",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects malformed types", () => {
    expect(WorkflowProposalSchema.safeParse(null).success).toBe(false);
    expect(
      WorkflowProposalSchema.safeParse({ name: "x", steps: [] }).success,
    ).toBe(false);
    expect(
      WorkflowProposalSchema.safeParse({
        name: "x",
        steps: { a: { ...step(), dependsOn: "a" } },
      }).success,
    ).toBe(false);
    expect(
      WorkflowProposalSchema.safeParse({
        name: "x",
        steps: { a: { ...step(), inputs: "nope" } },
      }).success,
    ).toBe(false);
  });
});

describe("validateWorkflowProposal - accepted graph shapes", () => {
  it.each([
    ["a single step A", { a: step() }],
    ["a linear B -> A", { a: step(), b: step({ dependsOn: ["a"] }) }],
    [
      "a fan-in C -> A,B",
      {
        a: step(),
        b: step(),
        c: step({ dependsOn: ["a", "b"] }),
      },
    ],
    [
      "a fan-out A -> B,C",
      {
        a: step(),
        b: step({ dependsOn: ["a"] }),
        c: step({ dependsOn: ["a"] }),
      },
    ],
    [
      "a diamond A -> B,C -> D",
      {
        a: step(),
        b: step({ dependsOn: ["a"] }),
        c: step({ dependsOn: ["a"] }),
        d: step({ dependsOn: ["b", "c"] }),
      },
    ],
  ])("accepts %s", (_label, steps) => {
    const result = validateWorkflowProposal({ name: "Generated", steps });
    if (!result.success) {
      throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
    }
    expect(Object.keys(result.data.steps)).toEqual(Object.keys(steps));
  });

  it("returns parsed data rather than an unchecked cast", () => {
    const result = validateWorkflowProposal({ name: "Generated", steps: { a: step() } });
    expect(result.success).toBe(true);
    if (result.success) {
      const proposal: WorkflowProposal = result.data;
      expect(proposal.name).toBe("Generated");
    }
  });
});

describe("validateWorkflowProposal - structural rejection", () => {
  it("rejects an empty proposal", () => {
    const result = validateWorkflowProposal({ name: "Empty", steps: {} });
    expectIssue(result, "EMPTY_PROPOSAL");
  });

  it("rejects a proposal with too many steps", () => {
    const steps: Record<string, unknown> = {};
    for (let index = 0; index < MAX_PROPOSAL_STEPS + 1; index += 1) {
      steps[`s${index}`] = step();
    }
    expectIssue(validateWorkflowProposal({ name: "Big", steps }), "TOO_MANY_STEPS");
  });

  it("accepts exactly the maximum step count", () => {
    const steps: Record<string, unknown> = {};
    for (let index = 0; index < MAX_PROPOSAL_STEPS; index += 1) {
      steps[`s${index}`] = step();
    }
    expect(validateWorkflowProposal({ name: "Big", steps }).success).toBe(true);
  });

  it("rejects an invalid localRef and reports its path", () => {
    const result = validateWorkflowProposal({
      name: "Bad id",
      steps: { "bad ref": step() },
    });
    expectIssue(result, "INVALID_LOCAL_REF", "bad ref");
  });

  it("rejects a localRef containing the reference path separator", () => {
    const result = validateWorkflowProposal({
      name: "Bad id",
      steps: { "a.b": step() },
    });
    expectIssue(result, "INVALID_LOCAL_REF", "a.b");
  });

  it("rejects an invalid dependency and reports its step and index", () => {
    const result = validateWorkflowProposal({
      name: "Bad dep",
      steps: { a: step({ dependsOn: ["not a ref"] }) },
    });
    expectIssue(result, "INVALID_DEPENDENCY", "dependsOn");
  });

  it("distinguishes an unknown proposal field from an unknown step field", () => {
    expectIssue(
      validateWorkflowProposal({ name: "x", steps: { a: step() }, extra: 1 }),
      "UNKNOWN_PROPOSAL_FIELD",
    );
    expectIssue(
      validateWorkflowProposal({
        name: "x",
        steps: { a: step({ sneaky: true }) },
      }),
      "UNKNOWN_STEP_FIELD",
    );
  });

  it("cannot represent a duplicate localRef", () => {
    // The record-key design makes a duplicate unrepresentable: JSON object keys
    // are unique, so a repeated key collapses to one step at the parse boundary.
    // The schema also has no redundant `id` field that could drift from the key.
    const raw =
      '{"name":"dup","steps":{' +
      '"a":{"action":"task.create","inputs":{"title":"Create the onboarding task","projectId":"clxyz0000000000000000000a"},"dependsOn":[]},' +
      '"a":{"action":"task.create","inputs":{"title":"Create the onboarding task","projectId":"clxyz0000000000000000000a"},"dependsOn":[]}}}';
    const result = validateWorkflowProposal(JSON.parse(raw));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.steps)).toEqual(["a"]);
    }
  });
});

describe("validateWorkflowProposal - action resolution", () => {
  it("rejects an action that is not a registered workflow action", () => {
    const result = validateWorkflowProposal({
      name: "Unknown",
      steps: { a: step({ action: "comment.add", inputs: {} }) },
    });
    expectIssue(result, "UNKNOWN_ACTION", "steps.a.action");
  });

  it("rejects the action path precisely", () => {
    const result = validateWorkflowProposal({
      name: "Unknown",
      steps: { a: step({ action: "utils.generate_report", inputs: {} }) },
    });
    const issues = issuesOf(result);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_ACTION", path: "steps.a.action" }),
    );
  });
});

describe("validateWorkflowProposal - input validation reuses capabilities", () => {
  it("rejects a missing required input with a field path", () => {
    const result = validateWorkflowProposal({
      name: "Missing",
      steps: {
        create: step({
          inputs: { projectId: "clxyz0000000000000000000a" },
        }),
      },
    });
    expectIssue(result, "MISSING_REQUIRED_INPUT", "steps.create.inputs.title");
  });

  it("rejects a malformed literal value with the capability message", () => {
    const result = validateWorkflowProposal({
      name: "Malformed",
      steps: {
        create: step({
          inputs: { title: "ab", projectId: "clxyz0000000000000000000a" },
        }),
      },
    });
    const issues = issuesOf(result);
    const title = issues.find((issue) => issue.path === "steps.create.inputs.title");
    expect(title?.code).toBe("INVALID_INPUT");
    expect(title?.message).toContain("at least 3 characters");
  });

  it("rejects an unknown input field, which strictness would otherwise drop", () => {
    const result = validateWorkflowProposal({
      name: "Extra",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            orgId: "attacker-controlled",
          },
        }),
      },
    });
    expectIssue(result, "UNKNOWN_INPUT_FIELD", "steps.create.inputs.orgId");
  });

  it("accepts a reference template where a literal would be rejected", () => {
    // `{{create_project.outputs.projectId}}` is not a cuid, so a literal-first
    // validator would reject it. It is deferred, not wrong, so it must pass and
    // be resolved later (37.3).
    const result = validateWorkflowProposal({
      name: "Referenced",
      steps: {
        create_project: step(),
        create_task: step({
          inputs: {
            title: "Follow-up task",
            projectId: "{{create_project.outputs.projectId}}",
          },
          dependsOn: ["create_project"],
        }),
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a reference template for a constrained enum input", () => {
    const result = validateWorkflowProposal({
      name: "Referenced enum",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            priority: "{{triage.outputs.priority}}",
          },
        }),
      },
    });
    expect(result.success).toBe(true);
  });

  it("does not forgive a reference hidden in an undeclared field", () => {
    const result = validateWorkflowProposal({
      name: "Smuggled",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            orgId: "{{session.outputs.orgId}}",
          },
        }),
      },
    });
    expectIssue(result, "UNKNOWN_INPUT_FIELD", "steps.create.inputs.orgId");
  });

  it("reports only the malformed field when a sibling is a valid reference", () => {
    const result = validateWorkflowProposal({
      name: "Mixed",
      steps: {
        create: step({
          inputs: {
            title: "ab",
            projectId: "{{create_project.outputs.projectId}}",
          },
        }),
      },
    });
    const issues = issuesOf(result);
    expect(codes(issues)).toEqual(["INVALID_INPUT"]);
    expect(issues[0].path).toBe("steps.create.inputs.title");
  });
});

describe("validateWorkflowProposal - resource bounds", () => {
  it("rejects a proposal whose serialized size exceeds the limit", () => {
    const result = validateWorkflowProposal({
      name: "Huge",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            description: "x".repeat(MAX_PROPOSAL_SERIALIZED_LENGTH),
          },
        }),
      },
    });
    expectIssue(result, "PROPOSAL_TOO_LARGE");
  });

  it("rejects inputs nested beyond the depth limit", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 12; index += 1) {
      nested = { nested };
    }
    const result = validateWorkflowProposal({
      name: "Deep",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            description: nested,
          },
        }),
      },
    });
    expectIssue(result, "INPUT_TOO_DEEP", "steps.create.inputs");
  });

  it("rejects an extreme nesting depth without overflowing the stack", () => {
    // A recursive walk overflows here; the bounded, iterative traversal stops
    // once it passes the limit, so this returns instead of crashing.
    let nested: unknown = "leaf";
    for (let index = 0; index < 50_000; index += 1) {
      nested = { nested };
    }
    const result = validateWorkflowProposal({
      name: "Abyss",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            description: nested,
          },
        }),
      },
    });
    expectIssue(result, "INPUT_TOO_DEEP", "steps.create.inputs");
  });

  it("returns a structured failure for a cyclic input instead of hanging", () => {
    const cyclic: Record<string, unknown> = {
      title: "valid title",
      projectId: "clxyz0000000000000000000a",
    };
    cyclic.self = cyclic;
    const result = validateWorkflowProposal({
      name: "Cycle",
      steps: { create: step({ inputs: cyclic }) },
    });
    expectIssue(result, "INPUT_TOO_DEEP", "steps.create.inputs");
  });

  it("returns a structured failure for a non-serializable input instead of throwing", () => {
    // `JSON.stringify` throws a `TypeError` on a `BigInt`. The validator must
    // turn that into an ordinary rejection; if it leaked, this test would fail
    // with an unhandled exception before the assertion ran.
    const result = validateWorkflowProposal({
      name: "BigInt",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            counter: BigInt(1),
          },
        }),
      },
    });
    expectIssue(result, "INVALID_INPUT", "steps.create.inputs");
  });

  it("checks depth before serialization, so a nested non-serializable value is reported as too deep", () => {
    let nested: unknown = BigInt(1);
    for (let index = 0; index < 12; index += 1) {
      nested = { nested };
    }
    const result = validateWorkflowProposal({
      name: "Deep BigInt",
      steps: {
        create: step({
          inputs: {
            title: "valid title",
            projectId: "clxyz0000000000000000000a",
            payload: nested,
          },
        }),
      },
    });
    expectIssue(result, "INPUT_TOO_DEEP", "steps.create.inputs");
  });

  it("rejects an oversized proposal without running downstream action validation", () => {
    // The step also names an unregistered action. If the size bound did not
    // short-circuit, `UNKNOWN_ACTION` would appear alongside `PROPOSAL_TOO_LARGE`.
    const result = validateWorkflowProposal({
      name: "Huge",
      steps: {
        create: step({
          action: "not.registered",
          inputs: {
            title: "valid title",
            blob: "x".repeat(MAX_PROPOSAL_SERIALIZED_LENGTH),
          },
        }),
      },
    });
    expect(codes(issuesOf(result))).toEqual(["PROPOSAL_TOO_LARGE"]);
  });
});

describe("structural validation is not full graph validation", () => {
  it("accepts a grammar-valid dependency on a step that does not exist", () => {
    // Dependency existence is 37.3/37.4. Rejecting it here would move the rule
    // to the wrong phase and contradict the documented boundary.
    const result = validateWorkflowProposal({
      name: "Dangling",
      steps: { a: step({ dependsOn: ["missing_step"] }) },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a self-dependency structurally (acyclicity is 37.4)", () => {
    const result = validateWorkflowProposal({
      name: "Cycle",
      steps: { a: step({ dependsOn: ["a"] }) },
    });
    expect(result.success).toBe(true);
  });
});

describe("the local-ref grammar stays compatible with the resolver", () => {
  it("matches the resolver's reference template, with no second dialect", () => {
    // resolver.ts:51 uses /\{\{[\w.-]+\}\}/ for activation. This module must not
    // invent a different pattern for the same concept.
    expect(REFERENCE_TEMPLATE_PATTERN.source).toBe("\\{\\{[\\w.-]+\\}\\}");
    expect(isReferenceTemplate("{{a.outputs.b}}")).toBe(true);
    expect(isReferenceTemplate("Task for {{a.outputs.title}}")).toBe(true);
    expect(isReferenceTemplate("a.outputs.b")).toBe(false);
    expect(isReferenceTemplate(42)).toBe(false);
  });

  it("never emits a localRef that cannot be placed in a reference", () => {
    for (const valid of ["a", "step_1", "step-1", "_private", "A1"]) {
      expect(PROPOSAL_LOCAL_REF_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "a.b", "a b", "{{a}}", "1st", "a/b"]) {
      expect(PROPOSAL_LOCAL_REF_PATTERN.test(invalid)).toBe(false);
    }
  });
});

describe("client safety", () => {
  it("imports only zod and the capability catalog at runtime", () => {
    const source = readSource(
      "src/lib/workflow-types/workflow-proposal.ts",
    );
    const specs = importSpecifiers(source);
    expect(specs.sort()).toEqual(["zod", "./action-capabilities"].sort());
    for (const bad of [
      "@/lib/prisma",
      "@/lib/workflow/actions",
      "@/lib/ai",
      "./action-registry",
      "./registry",
    ]) {
      expect(specs.some((spec) => spec.startsWith(bad))).toBe(false);
    }
  });
});
