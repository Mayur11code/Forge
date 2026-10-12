// src/lib/workflow-types/workflow-proposal-references.ts
//
// ASSIGNMENT 37.3 — REFERENCE GRAMMAR + VALIDATOR.
//
// A pure, read-only preflight over a structurally-valid `WorkflowProposal`. It
// answers one question the runtime cannot answer early: "does every
// `{{...}}` output reference in this proposal name something the graph will
// actually have produced, and does the referencing step declare the dependency
// that guarantees ordering?"
//
// The runtime resolver (src/lib/workflow/execution/resolver.ts) performs no such
// check. It resolves at dispatch time and fails silently: a missing path becomes
// `""` inside a larger string, and the literal `{{...}}` text when the
// reference is the whole value (resolver.ts:64-85). This module is the earlier,
// deterministic pass that turns those silent mismatches into structured issues.
//
// It is a second READER of the existing grammar, not a second grammar:
//
//   resolver.ts:51,63  /\{\{([\w.-]+)\}\}/g     (path class [\w.-])
//   resolver.ts:66     /^\{\{([\w.-]+)\}\}$/    (whole-string form)
//
// The resolver is deliberately NOT imported and NOT modified. Its parsing is not
// exported, and re-implementing it behind an exported boundary would either
// change its behaviour or duplicate it unsafely. Instead this file mirrors the
// grammar and a parity test (proposal-references.test.ts) exercises the real
// `resolveInputs` against the same strings to show the two stay aligned.
//
// Client-safe by construction, like ./workflow-proposal.ts and
// ./action-capabilities.ts: it imports `zod` and the capability catalog, and
// nothing from the server-only action implementations.

import { z } from "zod";

import { getActionCapability } from "./action-capabilities";
import type {
  ProposalIssue,
  WorkflowProposal,
  WorkflowProposalStep,
} from "./workflow-proposal";

/**
 * The runtime resolver's interpolation token, mirrored verbatim from
 * `resolver.ts:63`. Kept as a module constant rather than re-derived so the
 * parity test can point at one definition.
 */
const REFERENCE_TOKEN_PATTERN = /\{\{([\w.-]+)\}\}/g;

/** The only namespace a step's runtime object exposes (`state.ts:62-67`). */
const STEP_OUTPUT_NAMESPACE = "outputs";

/** The separate runtime namespace primed by `startWorkflow` (`trigger.ts:25`). */
const TRIGGER_SOURCE = "trigger";

/**
 * Path segments that can reach an object's prototype or its inherited members
 * through the resolver's `current[part]` traversal (`resolver.ts:35`).
 *
 * `resolver.ts` walks into any object it is handed, so `{{a.outputs.__proto__}}`
 * would follow the prototype chain rather than a real output. Referenceable
 * output names are derived from declared schemas and never use these segments,
 * so rejecting them cannot reject a legitimate reference. This is a preflight
 * guard for generated proposals only; it does not fix the resolver for
 * arbitrary pre-existing workflows, whose runtime posture is out of scope here.
 */
export const UNSAFE_REFERENCE_SEGMENTS: readonly string[] = [
  "__proto__",
  "prototype",
  "constructor",
];

/**
 * Source namespaces that exist at runtime but are deliberately outside a
 * proposal's reach: tenant, identity, session, database and process state.
 * A generated proposal must read workflow steps and `trigger`, nothing else
 * (AD-10). These names are only consulted for a source that is NOT a proposal
 * step, so naming a step `user` still resolves as a step.
 */
export const RESERVED_REFERENCE_SOURCES: readonly string[] = [
  "org",
  "organization",
  "organizations",
  "orgId",
  "tenant",
  "tenantId",
  "user",
  "users",
  "userId",
  "account",
  "accounts",
  "session",
  "sessions",
  "auth",
  "database",
  "databases",
  "db",
  "prisma",
  "env",
  "process",
  "global",
  "globalThis",
  "window",
  "document",
  "secret",
  "secrets",
  "token",
  "tokens",
  "apikey",
  "apiKey",
  "credential",
  "credentials",
  "workflow",
  "workflowRun",
  "run",
  "runId",
  "stepRun",
];

/**
 * Statically-verifiable `trigger.outputs.*` fields.
 *
 * Empty on purpose, and this is the honest state of the repository: `triggerData`
 * is an unconstrained `Record<string, JsonValue>` (`execution/trigger.ts:12,25`)
 * and a `WorkflowProposal` carries no trigger identifier, so no field can be
 * shown to exist for a given proposal. `AVAILABLE_TRIGGERS` in `registry.ts` is
 * UI presentation keyed by event id, not a proposal-addressable contract. The
 * trigger path is therefore handled specially (no `dependsOn` is required of it)
 * and fails closed: an unestablished field is rejected rather than allowed.
 *
 * If a real trigger-output contract is added later, list its fields here; the
 * check below already reads from this list.
 */
export const STATIC_TRIGGER_OUTPUT_FIELDS: readonly string[] = [];

/** The two parts of a scanned string: recognized references and a malformed flag. */
export type ExtractedReferences = {
  /** Well-formed reference paths, in the order they occur. */
  references: string[];
  /**
   * True when the string contains `{{` or `}}` that is not part of a
   * well-formed token — an attempted-but-broken reference. The resolver would
   * silently treat such text as a literal; this validator rejects it.
   */
  malformed: boolean;
};

/**
 * Extract the reference paths from a string using the resolver's grammar.
 *
 * A string with no `{{`/`}}` is ordinary text and yields nothing. A string that
 * carries `{{` or `}}` that is not part of a well-formed token is flagged
 * `malformed`, so an incomplete delimiter is rejected rather than ignored — the
 * resolver would otherwise leave it as literal text and the mistake would
 * surface only as wrong runtime data.
 */
export function extractReferences(value: string): ExtractedReferences {
  const references: string[] = [];
  const residue: string[] = [];
  let cursor = 0;

  for (const match of value.matchAll(REFERENCE_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    residue.push(value.slice(cursor, index));
    cursor = index + match[0].length;
    references.push(match[1]);
  }
  residue.push(value.slice(cursor));

  const leftover = residue.join("");
  return {
    references,
    malformed: leftover.includes("{{") || leftover.includes("}}"),
  };
}

/**
 * Validate every output reference in a proposal.
 *
 * Pure and read-only: the proposal is never mutated. Deterministic: steps are
 * visited in their own key order and each step's inputs depth-first in
 * declaration order, so the same proposal and catalog always produce the same
 * issues in the same order. Returns an empty array when the proposal is
 * reference-clean.
 *
 * The caller is expected to have run `validateWorkflowProposal` first: this
 * function trusts the structural guarantees of `WorkflowProposal` (local-id
 * grammar, known actions, bounded depth) and adds only the reference and
 * data-dependency rules, rather than re-deriving them.
 */
export function validateProposalReferences(
  proposal: WorkflowProposal,
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const knownSources = new Set<string>(Object.keys(proposal.steps));

  for (const [localRef, step] of Object.entries(proposal.steps)) {
    const base = `steps.${localRef}.inputs`;
    for (const [key, value] of Object.entries(step.inputs)) {
      walkInputValue(value, `${base}.${key}`, localRef, step, proposal, knownSources, issues);
    }
  }

  return issues;
}

/**
 * Walk one input value depth-first, validating every string leaf.
 *
 * Objects, arrays and primitives are all traversed — a reference may be nested
 * arbitrarily deep (the resolver walks nested objects, and `MAX_INPUT_DEPTH`
 * bounds that walk in 37.2), and array positions appear in issue paths so a
 * reviewer can locate the offending value.
 */
function walkInputValue(
  value: unknown,
  path: string,
  consumerRef: string,
  consumerStep: WorkflowProposalStep,
  proposal: WorkflowProposal,
  knownSources: Set<string>,
  issues: ProposalIssue[],
): void {
  if (typeof value === "string") {
    validateStringReferences(
      value,
      path,
      consumerRef,
      consumerStep,
      proposal,
      knownSources,
      issues,
    );
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkInputValue(
        item,
        `${path}.${index}`,
        consumerRef,
        consumerStep,
        proposal,
        knownSources,
        issues,
      );
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      walkInputValue(
        nested,
        `${path}.${key}`,
        consumerRef,
        consumerStep,
        proposal,
        knownSources,
        issues,
      );
    }
  }
}

/**
 * Validate every `{{...}}` token in one string value, plus a malformed-delimiter
 * check. An ordinary string with no reference syntax produces nothing.
 */
function validateStringReferences(
  value: string,
  path: string,
  consumerRef: string,
  consumerStep: WorkflowProposalStep,
  proposal: WorkflowProposal,
  knownSources: Set<string>,
  issues: ProposalIssue[],
): void {
  const { references, malformed } = extractReferences(value);
  if (references.length === 0 && !malformed) {
    return;
  }

  if (malformed) {
    issues.push({
      code: "MALFORMED_REFERENCE",
      path,
      message:
        `"${describe(value)}" contains "{{" or "}}" that is not a complete ` +
        `reference; the resolver would leave it as literal text.`,
    });
  }

  for (const reference of references) {
    const issue = analyzeReference(
      reference,
      consumerRef,
      consumerStep,
      proposal,
      knownSources,
    );
    if (issue) {
      issues.push({ ...issue, path });
    }
  }
}

/**
 * Classify one well-formed reference path. Returns the issue it raises, or
 * `undefined` when the reference is valid.
 *
 * Order matters and is deliberate:
 *   1. structural sanity (empty segments),
 *   2. prototype/scope safety before anything else,
 *   3. source resolution (step id, `trigger`, or an out-of-scope namespace),
 *   4. output-path validity against the action's declared contract,
 *   5. the explicit data-dependency rule.
 */
function analyzeReference(
  reference: string,
  consumerRef: string,
  consumerStep: WorkflowProposalStep,
  proposal: WorkflowProposal,
  knownSources: Set<string>,
): Omit<ProposalIssue, "path"> | undefined {
  const segments = reference.split(".");

  if (segments.some((segment) => segment.length === 0)) {
    return {
      code: "MALFORMED_REFERENCE",
      message: `"{{${reference}}}" has an empty path segment.`,
    };
  }

  const unsafe = segments.find((segment) =>
    UNSAFE_REFERENCE_SEGMENTS.includes(segment),
  );
  if (unsafe !== undefined) {
    return {
      code: "UNSAFE_REFERENCE_PATH",
      message: `"{{${reference}}}" traverses the prototype-sensitive segment "${unsafe}".`,
    };
  }

  const source = segments[0];

  if (source === TRIGGER_SOURCE) {
    return analyzeTriggerReference(reference, segments);
  }

  if (!knownSources.has(source)) {
    if (RESERVED_REFERENCE_SOURCES.includes(source)) {
      return {
        code: "UNAVAILABLE_REFERENCE_SCOPE",
        message:
          `"{{${reference}}}" reads the out-of-scope "${source}" namespace; a ` +
          `proposal may reference only its own steps and "trigger".`,
      };
    }
    return {
      code: "UNKNOWN_REFERENCE_SOURCE",
      message: `"{{${reference}}}" names step "${segments[0]}", which is not a step in this proposal.`,
    };
  }

  return analyzeStepReference(
    reference,
    segments,
    consumerRef,
    consumerStep,
    proposal,
  );
}

/** Validate a `<step>.outputs.<field...>` reference against the step's contract. */
function analyzeStepReference(
  reference: string,
  segments: string[],
  consumerRef: string,
  consumerStep: WorkflowProposalStep,
  proposal: WorkflowProposal,
): Omit<ProposalIssue, "path"> | undefined {
  const source = segments[0];

  if (segments[1] !== STEP_OUTPUT_NAMESPACE) {
    return {
      code: "MALFORMED_REFERENCE",
      message:
        `"{{${reference}}}" must address "${STEP_OUTPUT_NAMESPACE}" ` +
        `(as "<step>.${STEP_OUTPUT_NAMESPACE}.<field>").`,
    };
  }

  const outputFields = segments.slice(2);
  if (outputFields.length === 0) {
    return {
      code: "MALFORMED_REFERENCE",
      message: `"{{${reference}}}" is missing the output field.`,
    };
  }

  const sourceStep = proposal.steps[source];
  const capability = sourceStep
    ? getActionCapability(sourceStep.action)
    : undefined;

  if (!capability || !outputPathExists(capability.output, outputFields)) {
    const action = sourceStep?.action ?? "unknown";
    return {
      code: "UNKNOWN_OUTPUT",
      message:
        `"{{${reference}}}" names output "${outputFields.join(".")}", which ` +
        `step "${source}" (action "${action}") does not declare.`,
    };
  }

  if (source === consumerRef) {
    return {
      code: "SELF_REFERENCE",
      message: `Step "${consumerRef}" references its own output; a step cannot depend on itself.`,
    };
  }

  if (!consumerStep.dependsOn.includes(source)) {
    return {
      code: "MISSING_DATA_DEPENDENCY",
      message:
        `Step "${consumerRef}" reads "{{${reference}}}" but does not list ` +
        `"${source}" in dependsOn. A reference requires an explicit execution ` +
        `dependency on its source.`,
    };
  }

  return undefined;
}

/**
 * Validate a `trigger.outputs.*` reference.
 *
 * The trigger is a separate runtime namespace, not a proposal step, so it never
 * requires a `dependsOn` entry. Its fields, however, have no authoritative
 * static contract (see `STATIC_TRIGGER_OUTPUT_FIELDS`), so an unlisted field
 * fails closed rather than being silently accepted.
 */
function analyzeTriggerReference(
  reference: string,
  segments: string[],
): Omit<ProposalIssue, "path"> | undefined {
  if (segments[1] !== STEP_OUTPUT_NAMESPACE) {
    return {
      code: "MALFORMED_REFERENCE",
      message:
        `"{{${reference}}}" must address ` +
        `"${TRIGGER_SOURCE}.${STEP_OUTPUT_NAMESPACE}.<field>".`,
    };
  }

  const outputFields = segments.slice(2);
  if (outputFields.length === 0) {
    return {
      code: "MALFORMED_REFERENCE",
      message: `"{{${reference}}}" is missing the trigger output field.`,
    };
  }

  if (!STATIC_TRIGGER_OUTPUT_FIELDS.includes(outputFields[0])) {
    return {
      code: "UNKNOWN_OUTPUT",
      message:
        `"{{${reference}}}" reads trigger output "${outputFields.join(".")}", ` +
        `but the repository declares no statically-verifiable trigger-output ` +
        `contract; it is rejected (fail closed).`,
    };
  }

  return undefined;
}

/**
 * True when `segments` names an exact, declared path in a capability output
 * schema.
 *
 * Walks the Zod schema rather than a flat name list so nested outputs work if a
 * future action declares them: a field is accepted only where the schema itself
 * establishes it, and a primitive has no descendants. `unwrapSchema` peels
 * optionality wrappers so `.optional()`/`.default()` around an object does not
 * hide its fields. Own-key checks (never `in`) keep prototype members such as
 * `constructor` from ever counting as a declared field.
 */
function outputPathExists(output: z.ZodType, segments: string[]): boolean {
  let current: z.ZodType = unwrapSchema(output);

  for (const segment of segments) {
    current = unwrapSchema(current);
    if (!(current instanceof z.ZodObject)) {
      return false;
    }
    const shape = current.shape as Record<string, z.ZodType>;
    if (!Object.prototype.hasOwnProperty.call(shape, segment)) {
      return false;
    }
    current = shape[segment];
  }

  return true;
}

/**
 * Peel `.optional()` / `.nullable()` / `.default()` / `.catch()` wrappers to
 * reach the underlying type. Mirrors the bounded unwrap used by the canvas
 * projection (`registry.ts:109-117`) without importing presentation code.
 */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let i = 0; i < 10; i += 1) {
    const next = (current as { unwrap?: () => z.ZodType }).unwrap?.();
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

/** A short, single-line, quoted rendering of an offending string value. */
function describe(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}
