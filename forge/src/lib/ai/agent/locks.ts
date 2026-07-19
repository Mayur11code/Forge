import "server-only";

import { redis } from "@/lib/redis/client";

import {
  AGENT_SESSION_LOCK_TTL_MS,
  AGENT_TOOL_EXECUTION_LOCK_TTL_MS,
} from "./constants";

const SESSION_LOCK_PREFIX = "agent_session_lock:";
const TOOL_EXECUTION_LOCK_PREFIX = "agent_tool_execution_lock:";

const releaseLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

function createLockToken() {
  return crypto.randomUUID();
}

async function withLock<T>({
  key,
  ttlMs,
  callback,
}: {
  key: string;
  ttlMs: number;
  callback: () => Promise<T>;
}): Promise<T | null> {
  const token = createLockToken();

  const acquired = await redis.set(key, token, {
    nx: true,
    px: ttlMs,
  });

  if (acquired !== "OK") {
    return null;
  }

  try {
    return await callback();
  } finally {
    await redis.eval(releaseLockScript, [key], [token]);
  }
}

export async function withAgentSessionLock<T>(
  sessionId: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  return withLock({
    key: `${SESSION_LOCK_PREFIX}${sessionId}`,
    ttlMs: AGENT_SESSION_LOCK_TTL_MS,
    callback,
  });
}

export async function withToolExecutionLock<T>(
  executionId: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  return withLock({
    key: `${TOOL_EXECUTION_LOCK_PREFIX}${executionId}`,
    ttlMs: AGENT_TOOL_EXECUTION_LOCK_TTL_MS,
    callback,
  });
}