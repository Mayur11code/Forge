// src/lib/locking/redis-lock.ts
//
// The single Redis lock primitive used by every exclusive section in the
// codebase.
//
// This exists because there were two lock modules with the same token-compare
// protocol written out twice: the agent's (`@/lib/ai/agent/locks`, 30s TTL) and
// the workflow engine's (`@/lib/workflow/execution/mutex`, 5s TTL). The TTL and
// the key namespace legitimately differ per caller; the safety argument does
// not, and a copy of it is a comment that will drift out of date while still
// looking authoritative.
//
// Both callers must read the two invariants below before changing anything here.
//
//   1. Every mutation of the key is conditional on still holding the token.
//      Without that check, a worker that was slow past its TTL would extend or
//      delete a lock that had already been handed to somebody else.
//
//   2. `GET` and `PEXPIRE`/`DEL` happen inside one Lua script, not as two client
//      round trips. Between two round trips the key can change hands, and the
//      script is the only place the compare and the act are genuinely atomic.

import "server-only";

import { redis } from "@/lib/redis/client";

export const releaseLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

export const renewLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

/**
 * The value stored in the key and compared by both scripts.
 *
 * Exported for callers that cannot use `withTokenLock`, because their lock spans
 * several separate calls rather than wrapping one callback - the workflow
 * evaluator takes the lock, does a pass, and releases it later. Those callers
 * still need the token to be produced the same way, because the release and
 * renewal scripts compare against it by string equality and a second generation
 * scheme would be a second definition of what a valid owner looks like.
 */
export function createLockToken() {
  return crypto.randomUUID();
}

/**
 * Keep the lock alive for as long as the callback runs.
 *
 * A flat TTL is a bet that work always finishes inside it. A Gemini call plus a
 * Prisma round trip can exceed 30s under load, at which point the lock silently
 * lapses, a second worker starts, and both write. Renewing while the work is in
 * flight removes that time budget entirely.
 *
 * The interval is derived from the TTL rather than hard-coded, so changing the
 * TTL cannot silently leave the heartbeat renewing too slowly to be useful.
 *
 * Ownership loss is recorded rather than thrown. A renewal can fail for two very
 * different reasons - the key moved on, or Redis itself hiccuped - and neither
 * is recoverable from inside the interval callback. What the caller needs is the
 * same information either way: stop assuming exclusivity, and let the
 * compare-and-set guards on the database writes do their job.
 */
export function startLockHeartbeat({
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
        console.error(`[LOCK] Failed to renew lock "${key}".`, error);
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

/**
 * Run `callback` while holding `key`, renewing for as long as it runs.
 *
 * Resolves `null` without invoking the callback when the lock is already held.
 * That `null` is coordination, not failure: the holder is doing the work, and
 * the caller needs to know the difference between "someone else has this" and
 * "Redis is down" - the first is normal, the second must be reported.
 */
export async function withTokenLock<T>({
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

  const heartbeat = startLockHeartbeat({ key, token, ttlMs });

  try {
    return await callback();
  } finally {
    heartbeat.stop();

    try {
      await redis.eval(releaseLockScript, [key], [token]);
    } catch (error) {
      console.error(`[LOCK] Failed to release lock "${key}".`, error);
    }
  }
}
