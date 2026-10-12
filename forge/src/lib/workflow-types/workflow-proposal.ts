// src/lib/workflow-types/workflow-proposal.ts
//
// THE AGENT-FACING PROPOSAL CONTRACT.
//
// `WorkflowProposal` is the typed boundary between model output and everything
// Forge does deterministically. It is deliberately NOT the persisted
// `WorkflowDefinition` (./workflow.ts). A proposal is what a model is allowed to
// author; a definition is what the backend owns. The two differ on purpose:
//
//   proposal (this file)                 definition (./workflow.ts)
//   ----------------------------------   --------------------------------------
//   steps: Record<localRef, step>        nodes: AppNode[] + edges: AppEdge[]
//   step.action: registered action id    WorkflowStep.action: z.string()
//   step.inputs: strict per capability   WorkflowStep.config: z.record(z.any())
//   step.dependsOn: local refs only      WorkflowStep.dependsOn: step ids
//   no id / kind / isCritical / routing  id, kind, isCritical, routingConditions
//   no coordinates, no run, no tenant    owned by persistence + execution
//
// Field-by-field reuse decision (Assignment 37.2):
//
//   PROPOSE     REUSE                        DECISION
//   ---------   --------------------------   ---------------------------------
//   name        (none; F2)                   Proposal-level field. Belongs in
//                                            Workflow.name, not definition.name.
//   description (none)                        Optional, bounded.
//   steps       NodeData / WorkflowStep[]     A RECORD keyed by localRef, not an
//                                            array: the key IS the logical step
//                                            identity (AD-08), so a duplicate id
//                                            is unrepresentable, and a redundant
//                                            `id` field cannot drift from it.
//   action      WorkflowStep.action           Reused shape, now membership-checked
//                                            against 37.1's capability catalog
//                                            (resolves I4).
//   inputs      WorkflowStep.config           Renamed, and validated against the
//                                            action's real input schema via the
//                                            capability catalog rather than
//                                            accepted as z.record(z.any()).
//   dependsOn   WorkflowStep.dependsOn        Same shape and semantics, restricted
//                                            to local refs by grammar.
//   (excluded)  id / kind / isCritical /      Backend-owned. A proposal must not
//               routingConditions / run       be able to name them (AD-10).
//
// This module performs STRUCTURAL validation only: shape, strictness, local-id
// grammar, action membership, and per-action input validity. It does NOT check
// dependency existence, acyclicity, output-reference resolution, or execution
// readiness. Those are 37.3 (references) and 37.4 (full graph validation), which
// consume this contract rather than being duplicated here. Deliberately, a
// structurally-valid proposal may reference a step that does not exist; that is
// the 37.3 concern, and rejecting it here would misplace the rule.
//
// Client-safe by construction, like ./action-capabilities.ts: it imports `zod`
// and the capability catalog and nothing else at runtime. No Prisma client, no
// server-only action implementation, no registry runtime edge. A future review
// UI (37.9) and the server-side generation path can both import it.

import { z } from "zod";

import {
  getActionCapability,
  requiredInputFields,
  type ActionCapability,
} from "./action-capabilities";

/**
 * Grammar for a proposal-local step identifier (`localRef`).
 *
 * Compatible with the resolver's `{{path}}` grammar (`[\w.-]+`,
 * src/lib/workflow/execution/resolver.ts:51) but STRICTER on purpose: dots are
 * excluded because a dot is the path separator, so an id containing one could
 * not be referenced unambiguously (`{{a.b.outputs.x}}`). Braces and whitespace
 * are excluded for the same reason. The result is an id that is always safe to
 * place in front of `.outputs.<field>`.
 */
export const PROPOSAL_LOCAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * A `{{...}}` output reference, using the EXISTING resolver grammar. The pattern
 * is shared with activation, not redefined as a second dialect: strings that
 * match are left in place for later resolution and, if they appear where a
 * literal value is expected, are accepted as deferred rather than rejected.
 */
export const REFERENCE_TEMPLATE_PATTERN = /\{\{[\w.-]+\}\}/;

/**
 * Maximum number of steps in a single proposal.
 *
 * Rationale: a generated workflow north of a few dozen steps is past what a
 * human reviewer (37.9) can meaningfully approve and past what the bounded model
 * loop (MAX_AGENT_STEPS = 5, src/lib/ai/agent/constants.ts) can author reliably.
 * 50 sits comfortably above any realistic graph while keeping the proposal small
 * enough to serialize, review and persist as one JSONB value. It is NOT the
 * evaluator's evaluation-pass count (MAX_EVALUATION_PASSES, evaluator.ts) — that
 * is an execution concern and must not bound what may be proposed.
 */
export const MAX_PROPOSAL_STEPS = 50;

/** Maximum length of a proposal name, in characters. */
export const MAX_PROPOSAL_NAME_LENGTH = 200;

/** Maximum length of the optional proposal description. */
export const MAX_PROPOSAL_DESCRIPTION_LENGTH = 2000;

/**
 * Maximum serialized size of a proposal, in UTF-16 code units as reported by
 * `JSON.stringify(...).length`.
 *
 * A capability bounds most individual fields, but `task.create.description` (and
 * future free-text inputs) are unbounded, so a proposal's total size needs its
 * own ceiling. 256 KiB is well under the QStash message ceiling and any JSONB
 * practical limit, and still far larger than any legitimate generated workflow.
 * Measured on the parsed proposal, so it never rejects a payload the structural
 * schema would have rejected anyway.
 */
export const MAX_PROPOSAL_SERIALIZED_LENGTH = 262_144;

/**
 * Maximum nesting depth of a step's `inputs` payload.
 *
 * Every catalogued action input is currently flat, but the resolver walks nested
 * objects, so a generated payload may nest. 8 levels is far above any legitimate
 * action argument and stops a pathological model response from forcing an
 * unbounded recursive walk.
 */
export const MAX_INPUT_DEPTH = 8;

/**
 * A single proposed step.
 *
 * `inputs` is an open `Record<string, unknown>` at this layer: the action-specific
 * shape is enforced by the capability catalog (see `validateWorkflowProposal`),
 * not restated here. `dependsOn` is required (an empty array means "no
 * prerequisite") so a proposal always states its dependencies explicitly, matching
 * the existing `WorkflowStepSchema`, where `dependsOn` has no default.
 */
export const WorkflowProposalStepSchema = z
  .object({
    action: z
      .string()
      .min(1, "A step must name a workflow action.")
      .describe("Id of a registered workflow action."),
    inputs: z
      .record(z.string(), z.unknown())
      .describe("Action-specific inputs, validated per action."),
    dependsOn: z
      .array(z.string())
      .describe("Proposal-local step ids this step depends on; [] means none."),
  })
  .strict();

/**
 * A whole proposal.
 *
 * Strict at both levels: an unknown proposal field or an unknown step field is
 * rejected rather than silently dropped, so a typo or an attempt to smuggle a
 * backend-owned field (`id`, `isCritical`, `routingConditions`) fails while the
 * model is still generating, not after the workflow is persisted.
 */
export const WorkflowProposalSchema = z
  .object({
    name: z
      .string()
      .min(1, "A proposal must have a name.")
      .max(
        MAX_PROPOSAL_NAME_LENGTH,
        `A proposal name must be at most ${MAX_PROPOSAL_NAME_LENGTH} characters.`,
      ),
    description: z
      .string()
      .max(
        MAX_PROPOSAL_DESCRIPTION_LENGTH,
        `A proposal description must be at most ${MAX_PROPOSAL_DESCRIPTION_LENGTH} characters.`,
      )
      .optional(),
    steps: z.record(z.string(), WorkflowProposalStepSchema),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const entries = Object.entries(proposal.steps);

    if (entries.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A workflow proposal must contain at least one step.",
        path: ["steps"],
        params: { proposalCode: "EMPTY_PROPOSAL" },
      });
    }

    if (entries.length > MAX_PROPOSAL_STEPS) {
      ctx.addIssue({
        code: "custom",
        message: `A workflow proposal may contain at most ${MAX_PROPOSAL_STEPS} steps.`,
        path: ["steps"],
        params: { proposalCode: "TOO_MANY_STEPS" },
      });
    }

    for (const [localRef, step] of entries) {
      if (!PROPOSAL_LOCAL_REF_PATTERN.test(localRef)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Step id "${localRef}" must start with a letter or underscore and ` +
            `contain only letters, digits, underscores or hyphens.`,
          path: ["steps", localRef],
          params: { proposalCode: "INVALID_LOCAL_REF" },
        });
      }

      step.dependsOn.forEach((dependency, index) => {
        if (!PROPOSAL_LOCAL_REF_PATTERN.test(dependency)) {
          ctx.addIssue({
            code: "custom",
            message: `Dependency "${dependency}" is not a valid step id.`,
            path: ["steps", localRef, "dependsOn", index],
            params: { proposalCode: "INVALID_DEPENDENCY" },
          });
        }
      });
    }
  });

export type WorkflowProposalStep = z.infer<typeof WorkflowProposalStepSchema>;
export type WorkflowProposal = z.infer<typeof WorkflowProposalSchema>;

/**
 * Machine-readable reason a proposal was rejected. Callers switch on this, not on
 * a message string, so wording can change without breaking a consumer.
 */
export type ProposalIssueCode =
  | "INVALID_PROPOSAL_STRUCTURE"
  | "UNKNOWN_PROPOSAL_FIELD"
  | "UNKNOWN_STEP_FIELD"
  | "EMPTY_PROPOSAL"
  | "TOO_MANY_STEPS"
  | "INVALID_LOCAL_REF"
  | "INVALID_DEPENDENCY"
  | "UNKNOWN_ACTION"
  | "MISSING_REQUIRED_INPUT"
  | "UNKNOWN_INPUT_FIELD"
  | "INVALID_INPUT"
  | "INPUT_TOO_DEEP"
  | "PROPOSAL_TOO_LARGE"
  // Assignment 37.3 — reference validation (workflow-proposal-references.ts).
  // These belong to the same issue system so a reviewer or the 37.4 compiler
  // switches on one code union rather than two parallel vocabularies.
  | "MALFORMED_REFERENCE"
  | "UNKNOWN_REFERENCE_SOURCE"
  | "UNKNOWN_OUTPUT"
  | "MISSING_DATA_DEPENDENCY"
  | "SELF_REFERENCE"
  | "UNAVAILABLE_REFERENCE_SCOPE"
  | "UNSAFE_REFERENCE_PATH";

/** One structured rejection. `path` is dotted, e.g. `steps.create.inputs.title`. */
export type ProposalIssue = {
  code: ProposalIssueCode;
  path: string;
  message: string;
};

export type ProposalValidationResult =
  | { success: true; data: WorkflowProposal }
  | { success: false; issues: ProposalIssue[] };

/**
 * True when a value is a string carrying at least one `{{...}}` reference.
 *
 * Such a value is a deferred reference, not a literal, so it must be accepted
 * wherever its eventual resolved value would be valid. This is the single rule
 * that lets `{{...}}` survive input validation without inventing a second
 * reference syntax.
 */
export function isReferenceTemplate(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_TEMPLATE_PATTERN.test(value);
}

/**
 * The strict validator. Runs the structural schema, then resolves every step's
 * action against the 37.1 capability catalog and validates its inputs against
 * that action's real input schema.
 *
 * Returns parsed data on success so callers never re-parse and never cast a raw
 * model object into a `WorkflowProposal` by hand.
 */
export function validateWorkflowProposal(
  input: unknown,
): ProposalValidationResult {
  const parsed = WorkflowProposalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: proposalIssuesFromZodIssues(parsed.error.issues),
    };
  }

  const proposal = parsed.data;

  // Depth is enforced BEFORE any serialization. The traversal is bounded and
  // non-recursive, so a pathologically nested payload is rejected without a
  // stack overflow and without being stringified first. A deep input is a
  // structural failure, so it short-circuits before action resolution.
  const depthIssues: ProposalIssue[] = [];
  for (const [localRef, step] of Object.entries(proposal.steps)) {
    if (exceedsMaxInputDepth(step.inputs)) {
      depthIssues.push({
        code: "INPUT_TOO_DEEP",
        path: `steps.${localRef}.inputs`,
        message:
          `Inputs for step "${localRef}" nest deeper than the ` +
          `${MAX_INPUT_DEPTH}-level limit.`,
      });
    }
  }
  if (depthIssues.length > 0) {
    return { success: false, issues: depthIssues };
  }

  // Serialize once, safely. The size bound is checked before any per-action
  // validation so an oversized proposal is rejected without downstream work, and
  // a value that cannot be serialized (a BigInt, or a cycle that spans steps)
  // becomes a structured issue rather than a thrown `TypeError`.
  const serialized = serializeProposal(proposal);
  if (!serialized.ok) {
    return { success: false, issues: serialized.issues };
  }
  if (serialized.size > MAX_PROPOSAL_SERIALIZED_LENGTH) {
    return {
      success: false,
      issues: [
        {
          code: "PROPOSAL_TOO_LARGE",
          path: "",
          message:
            `Proposal serializes to ${serialized.size} characters, above the ` +
            `${MAX_PROPOSAL_SERIALIZED_LENGTH}-character limit.`,
        },
      ],
    };
  }

  const issues: ProposalIssue[] = [];
  for (const [localRef, step] of Object.entries(proposal.steps)) {
    const capability = getActionCapability(step.action);
    if (!capability) {
      issues.push({
        code: "UNKNOWN_ACTION",
        path: `steps.${localRef}.action`,
        message: `Action "${step.action}" is not a registered workflow action.`,
      });
      continue;
    }
    issues.push(...validateStepInputs(localRef, step.inputs, capability));
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }
  return { success: true, data: proposal };
}

/**
 * Validate one step's inputs against its action capability.
 *
 * The capability's own strict schema is the source of truth: its messages,
 * bounds and enums are reused verbatim rather than re-derived. The only added
 * rule is that an issue whose offending value is a `{{...}}` reference is
 * forgiven — the value is deferred, not wrong. Unknown keys are never forgiven,
 * so a reference cannot be smuggled through a field the action does not declare.
 */
function validateStepInputs(
  localRef: string,
  inputs: Record<string, unknown>,
  capability: ActionCapability,
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const base = `steps.${localRef}.inputs`;

  const required = requiredInputFields(capability.input);
  const parsed = capability.input.safeParse(inputs);
  if (parsed.success) {
    return issues;
  }

  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({
          code: "UNKNOWN_INPUT_FIELD",
          path: `${base}.${String(key)}`,
          message: `Unknown input "${String(key)}" for action "${capability.id}".`,
        });
      }
      continue;
    }

    if (isReferenceTemplate(valueAtPath(inputs, issue.path))) {
      continue;
    }

    const root = issue.path[0];
    const isMissingRequired =
      typeof root === "string" &&
      required.includes(root) &&
      (inputs as Record<string, unknown>)[root] === undefined;

    issues.push({
      code: isMissingRequired ? "MISSING_REQUIRED_INPUT" : "INVALID_INPUT",
      path: appendPath(base, issue.path),
      message: issue.message,
    });
  }

  return issues;
}

type ZodIssueLike = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: readonly PropertyKey[];
  params?: unknown;
};

function proposalIssuesFromZodIssues(
  issues: readonly ZodIssueLike[],
): ProposalIssue[] {
  const result: ProposalIssue[] = [];

  for (const issue of issues) {
    const custom = customIssueCode(issue);
    if (custom) {
      result.push({
        code: custom,
        path: dottedPath(issue.path),
        message: issue.message,
      });
      continue;
    }

    if (issue.code === "unrecognized_keys" && issue.keys) {
      const container = dottedPath(issue.path);
      const code =
        issue.path.length === 0 ? "UNKNOWN_PROPOSAL_FIELD" : "UNKNOWN_STEP_FIELD";
      for (const key of issue.keys) {
        const name = String(key);
        result.push({
          code,
          path: container ? `${container}.${name}` : name,
          message: `Unrecognized key: "${name}".`,
        });
      }
      continue;
    }

    result.push({
      code: "INVALID_PROPOSAL_STRUCTURE",
      path: dottedPath(issue.path),
      message: issue.message,
    });
  }

  return result;
}

function customIssueCode(issue: ZodIssueLike): ProposalIssueCode | undefined {
  const params = issue.params as
    | { proposalCode?: ProposalIssueCode }
    | undefined;
  return params?.proposalCode;
}

function dottedPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

function appendPath(base: string, path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return base;
  }
  return `${base}.${dottedPath(path)}`;
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/**
 * True when `value` nests deeper than `MAX_INPUT_DEPTH`.
 *
 * Bounded and iterative on purpose. A recursive walk visits every node and only
 * compares afterwards, which lets a pathological payload drive a deep stack and
 * keeps working after the limit is already exceeded. This version uses an
 * explicit stack and returns the instant a value sits past the limit, so it
 * touches only nodes down to `MAX_INPUT_DEPTH + 1` and cannot overflow — a cycle
 * is also stopped, because it necessarily exceeds the depth bound.
 *
 * Depth accounting is unchanged: a direct child of the top-level `inputs` object
 * sits at depth 1, and arrays and objects both contribute a level.
 */
function exceedsMaxInputDepth(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    const children = childrenOf(frame.value);
    if (children === undefined) {
      continue;
    }

    const childDepth = frame.depth + 1;
    if (children.length > 0 && childDepth > MAX_INPUT_DEPTH) {
      return true;
    }
    for (const child of children) {
      stack.push({ value: child, depth: childDepth });
    }
  }

  return false;
}

/** Child values of an array or object; `undefined` for a leaf. */
function childrenOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Serialize a proposal, converting a `TypeError` from a non-serializable value
 * into structured issues. `validateWorkflowProposal` must never throw, so this
 * is the boundary where an unserializable payload is contained.
 */
function serializeProposal(
  proposal: WorkflowProposal,
): { ok: true; size: number } | { ok: false; issues: ProposalIssue[] } {
  try {
    return { ok: true, size: serializedLength(proposal) };
  } catch {
    return { ok: false, issues: nonSerializableIssues(proposal) };
  }
}

/**
 * Locate the step whose inputs cannot be serialized, so the caller still gets a
 * path-bearing rejection instead of a thrown error. Falls back to a
 * proposal-level issue for a cycle that spans steps.
 */
function nonSerializableIssues(proposal: WorkflowProposal): ProposalIssue[] {
  const issues: ProposalIssue[] = [];

  for (const [localRef, step] of Object.entries(proposal.steps)) {
    try {
      JSON.stringify(step.inputs);
    } catch {
      issues.push({
        code: "INVALID_INPUT",
        path: `steps.${localRef}.inputs`,
        message:
          `Inputs for step "${localRef}" contain a value that cannot be ` +
          `serialized.`,
      });
    }
  }

  if (issues.length === 0) {
    issues.push({
      code: "INVALID_PROPOSAL_STRUCTURE",
      path: "",
      message: "The proposal contains a value that cannot be serialized.",
    });
  }

  return issues;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}
