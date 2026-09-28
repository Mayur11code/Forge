// src/lib/ai/agent/tools/policy.ts
//
// Capability classification for agent tools.
//
// This is TRUSTED, server-side metadata that lives with the tool registration.
// The model never supplies it, never sees it, and cannot influence it. A tool
// input field named `access`, `policy` or `requiresConfirmation` is not a thing
// the registry reads: policy is resolved from the tool NAME, server-side.

/**
 * What a tool is allowed to do.
 *
 * READ_ONLY   reads state. No side effects. Executes directly, no confirmation.
 * WRITE       creates or mutates state. Confirmation required.
 * DESTRUCTIVE removes state irreversibly. Confirmation required, always.
 */
export type ToolAccess = "READ_ONLY" | "WRITE" | "DESTRUCTIVE";

/**
 * A tool's policy is intentionally a single field.
 *
 * `requiresConfirmation` is DERIVED from `access` rather than stored alongside
 * it. A stored boolean could be constructed inconsistently - a tool declared
 * DESTRUCTIVE with requiresConfirmation: false would silently execute a
 * destructive action with no user approval, and nothing would fail loudly.
 *
 * Deriving it makes that state unrepresentable, which is the whole point of a
 * security control. It also means policy cannot be "overridden through tool
 * input": there is no second source for it to be overridden from.
 */
export type AgentToolPolicy = {
  readonly access: ToolAccess;
};

export const READ_ONLY_POLICY: AgentToolPolicy = Object.freeze({
  access: "READ_ONLY",
});

export const WRITE_POLICY: AgentToolPolicy = Object.freeze({
  access: "WRITE",
});

export const DESTRUCTIVE_POLICY: AgentToolPolicy = Object.freeze({
  access: "DESTRUCTIVE",
});

/**
 * Whether a tool must be approved by the user before it executes.
 *
 * READ_ONLY tools never require confirmation. WRITE and DESTRUCTIVE always do.
 */
export function requiresConfirmation(
  policy: AgentToolPolicy,
): boolean {
  return policy.access !== "READ_ONLY";
}

/**
 * A confirmation prompt rendered from the PERSISTED proposal arguments.
 *
 * This is derived server-side from `AgentToolExecution.input` - the exact
 * arguments that will be executed. It exists so the user approves something
 * concrete rather than approving an opaque "the assistant wants to run a tool".
 *
 * It is presentation only. Nothing in the confirm path reads these fields, and
 * nothing trusts them: the executor always reads `input`.
 */
export type ToolProposalSummary = {
  /** One-line description, e.g. "Create task in Website Redesign". */
  summary: string;
  /** Concrete rows for the confirmation UI, derived from the same input. */
  fields: { label: string; value: string }[];
};

/** Human-readable label for UI surfaces. */
export function describeAccess(access: ToolAccess): string {
  switch (access) {
    case "READ_ONLY":
      return "Read only";
    case "WRITE":
      return "Write";
    case "DESTRUCTIVE":
      return "Destructive";
  }
}
