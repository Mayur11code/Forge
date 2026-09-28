// src/lib/ai/agent/tools/registry.ts
//
// SINGLE source of truth for agent tools.
//
// Each entry binds three things that must never drift apart:
//   1. the AI SDK tool definition Gemini sees,
//   2. the server-side executor the worker runs,
//   3. the trusted capability policy that decides whether it runs directly or
//      waits for user confirmation.
//
// They are registered together because the risk is a tool existing on one side
// but not the other: an executor with no policy would run unconfirmed, and a
// policy with no executor would strand a session. One map makes that a
// compile error rather than a runtime surprise.
//
// Trust model:
// - Gemini only ever sees `agentTools`. It never sees executors or policies.
// - An executor receives the model-controlled `input` plus a TRUSTED
//   `ToolExecutionContext` whose `orgId`/`userId` are loaded by tool-worker.ts
//   from the PERSISTED AgentSession row. They must never be sourced from the
//   LLM input or from the queue payload.
// - Policy is resolved from the tool NAME, server-side. There is deliberately
//   no path by which tool input can select or relax it.

import type { ToolResultPart, ToolSet } from "ai";
import type { Prisma } from "@prisma/client";

import type { ToolExecutionContext } from "../types";

import {
  createTaskTool,
  describeCreateTaskProposal,
  executeCreateTask,
} from "./create-task";
import { executeListTasks, listTasksTool } from "./list-tasks";
import {
  describeUpdateTaskProposal,
  executeUpdateTask,
  updateTaskTool,
} from "./update-task";
import {
  READ_ONLY_POLICY,
  WRITE_POLICY,
  requiresConfirmation,
  type AgentToolPolicy,
  type ToolProposalSummary,
} from "./policy";

/**
 * Server-side tool executor.
 *
 * `input` is untrusted (model-controlled) and must be schema-validated.
 * `ctx` is trusted and must be used to scope every read and write.
 */
export type ToolExecutor = (
  input: Prisma.JsonValue,
  ctx: ToolExecutionContext,
) => Promise<ToolResultPart["output"]>;

type AgentToolEntry = {
  tool: ToolSet[string];
  executor: ToolExecutor;
  policy: AgentToolPolicy;
  /**
   * Optional: renders the PERSISTED proposal arguments for the confirmation
   * UI. Returns null when the arguments cannot be summarised, in which case
   * the caller falls back to a generic prompt.
   *
   * This is presentation only and must not be used to decide what executes.
   */
  describeProposal?: (input: unknown) => ToolProposalSummary | null;
};

const registry = {
  createTask: {
    tool: createTaskTool,
    executor: executeCreateTask,
    policy: WRITE_POLICY,
    describeProposal: describeCreateTaskProposal,
  },
  listTasks: {
    tool: listTasksTool,
    executor: executeListTasks,
    policy: READ_ONLY_POLICY,
  },
  updateTask: {
    tool: updateTaskTool,
    executor: executeUpdateTask,
    policy: WRITE_POLICY,
    describeProposal: describeUpdateTaskProposal,
  },
} satisfies Record<string, AgentToolEntry>;

export type AgentToolName = keyof typeof registry;

/**
 * Tool definitions exposed to the model. Policy and executors stay server-side.
 *
 * Derived from the registry rather than written out again: a hand-maintained
 * projection is exactly the duplicate this file exists to remove, because
 * nothing about it would make a forgotten tool a compile error.
 */
export const agentTools = Object.fromEntries(
  Object.entries(registry).map(([name, entry]) => [name, entry.tool]),
) as { [K in keyof typeof registry]: (typeof registry)[K]["tool"] };

function getEntry(toolName: string): AgentToolEntry | null {
  return (
    (registry as Record<string, AgentToolEntry>)[toolName] ?? null
  );
}

export function isRegisteredTool(toolName: string): boolean {
  return getEntry(toolName) !== null;
}

export function getToolExecutor(toolName: string): ToolExecutor {
  const executor = getEntry(toolName)?.executor;

  if (!executor) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return executor;
}

/**
 * Trusted policy for a tool, or null if the tool is not registered.
 *
 * A null result must fail the turn closed. Treat it as "do not execute" rather
 * than defaulting to a safe-looking policy.
 */
export function getToolPolicy(
  toolName: string,
): AgentToolPolicy | null {
  return getEntry(toolName)?.policy ?? null;
}

/**
 * Whether this tool needs explicit user approval before it runs.
 *
 * Unregistered tools return true: fail closed towards asking the user rather
 * than towards executing something the backend does not understand.
 */
export function requiresToolConfirmation(toolName: string): boolean {
  const policy = getToolPolicy(toolName);

  return policy === null ? true : requiresConfirmation(policy);
}

/**
 * Render a persisted proposal for confirmation UI.
 *
 * Falls back to a generic prompt rather than throwing, so a malformed
 * proposal can still be confirmed and then fail validation inside the
 * executor where the error message belongs to the model.
 */
export function describeToolProposal(
  toolName: string,
  input: unknown,
): ToolProposalSummary {
  const describe = getEntry(toolName)?.describeProposal;
  const described = describe?.(input) ?? null;

  if (described) {
    return described;
  }

  return {
    summary: `Run ${toolName}`,
    fields: [],
  };
}
