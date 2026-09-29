// src/lib/ai/agent/locks.ts
//
// Agent-specific lock namespacing on top of the shared Redis lock primitive.
//
// The locking protocol itself - token-compare release, token-guarded renewal,
// heartbeat for the duration of the work - lives in `@/lib/redis/../locking/redis-lock`
// and is shared with the workflow engine. What stays here is only what is
// genuinely agent-specific: the key prefixes and the TTLs, which come from
// `constants.ts` where the reasoning for their magnitudes already lives.

import "server-only";

import { withTokenLock } from "@/lib/locking/redis-lock";
import {
  AGENT_SESSION_LOCK_TTL_MS,
  AGENT_TOOL_EXECUTION_LOCK_TTL_MS,
} from "./constants";

const SESSION_LOCK_PREFIX = "agent_session_lock:";
const TOOL_EXECUTION_LOCK_PREFIX = "agent_tool_execution_lock:";

export async function withAgentSessionLock<T>(
  sessionId: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  return withTokenLock({
    key: `${SESSION_LOCK_PREFIX}${sessionId}`,
    ttlMs: AGENT_SESSION_LOCK_TTL_MS,
    callback,
  });
}

export async function withToolExecutionLock<T>(
  executionId: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  return withTokenLock({
    key: `${TOOL_EXECUTION_LOCK_PREFIX}${executionId}`,
    ttlMs: AGENT_TOOL_EXECUTION_LOCK_TTL_MS,
    callback,
  });
}
