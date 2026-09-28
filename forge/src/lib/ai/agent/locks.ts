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

/**
 * Extend the TTL only while we still own the lock.
 *
 * The token check matters: a plain PEXPIRE would happily extend a lock that
 * had already expired and been re-acquired by another worker, which would
 * then block that worker on its own lock and let two of them run at once.
 */
const renewLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

function createLockToken() {
  return crypto.randomUUID();
}

/**
 * Keep the lock alive for as long as the callback runs.
 *
 * A flat TTL is a bet that work always finishes inside it. A Gemini call plus
 * a Prisma round trip can exceed 30s under load, at which point the lock
 * silently lapses, a second worker starts, and both write. Renewing while the
 * work is in flight removes that time budget entirely.
 *
 * The interval is derived from the TTL rather than hard-coded, so changing the
 * TTL cannot silently leave the heartbeat renewing too slowly to be useful.
 */
function startHeartbeat({
  key,
  token,
  ttlMs,
}: {
  key: string;
  token: string;
  ttlMs: number;
}) {
  let stopped = false;
  let lost = false;

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }

    void (async () => {
      try {
        const renewed = await redis.eval(
          renewLockScript,
          [key],
          [token, String(ttlMs)],
        );

        if (renewed !== 1) {
          // Someone else owns this key now. The callback is still running, so
          // the only honest thing to do is say so loudly: the exclusivity
          // guarantee is gone.
          lost = true;
          console.error(
            `[LOCK] Lost ownership of "${key}" while work was in flight. ` +
              `Concurrent execution is possible.`,
          );
        }
      } catch (error) {
        console.error(
          `[LOCK] Failed to renew lock "${key}".`,
          error,
        );
      }
    })();
  }, Math.max(1_000, Math.floor(ttlMs / 3)));

  // Never hold the process open just to renew a lock.
  timer.unref?.();

  return {
    hasLostOwnership: () => lost,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
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

  const heartbeat = startHeartbeat({ key, token, ttlMs });

  try {
    return await callback();
  } finally {
    heartbeat.stop();

    try {
      await redis.eval(releaseLockScript, [key], [token]);
    } catch (error) {
      console.error(
        `[LOCK] Failed to release lock "${key}".`,
        error,
      );
    }
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
