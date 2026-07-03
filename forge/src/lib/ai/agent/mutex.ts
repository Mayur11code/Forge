import "server-only";

import { redis } from "@/lib/redis/client";
import { AGENT_SESSION_LOCK_TTL_MS } from "./constants";


const LOCK_PREFIX = "agent_session_lock:";

const releaseLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

function getLockKey(sessionId: string) {
  return `${LOCK_PREFIX}${sessionId}`;
}

function createLockToken() {
  return crypto.randomUUID();
}

/**
 * Runs a callback only when this worker owns the session lock.
 *
 * Returns:
 * - callback result when the lock was acquired
 * - null when another worker currently owns the lock
 *
 * Important:
 * The lock prevents concurrent work. `claimNextAgentStep()` remains
 * the final stale-event / duplicate-delivery guard in Postgres.
 */
export async function withAgentSessionLock<T>(
  sessionId: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  const lockKey = getLockKey(sessionId);
  const token = createLockToken();

  const acquired = await redis.set(lockKey, token, {
    nx: true,
    px: AGENT_SESSION_LOCK_TTL_MS,
  });

  if (acquired !== "OK") {
    return null;
  }

  try {
    return await callback();
  } finally {
    await redis.eval(releaseLockScript, [lockKey], [token]);
  }
}