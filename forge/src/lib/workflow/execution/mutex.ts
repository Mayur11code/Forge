// src/lib/workflow/execution/mutex.ts
//
// The workflow evaluator's run lock.
//
// The locking protocol is shared with the agent locks via
// `@/lib/locking/redis-lock`; what is specific here is the namespace and the TTL.
//
// The TTL is 5s, an order of magnitude below the agent's 30s, because the work
// under this lock is much shorter: it is a handful of Prisma writes plus the
// QStash publishes for the steps being dispatched. A flat 5s TTL was still a
// bet that one whole pass fits inside it, and that bet does not hold for a wide
// fan-out - a run with a dozen ready steps issues a dozen network round trips
// while the TTL counts down, and a lapsed lock means two evaluators racing on
// the same run. The heartbeat below removes the time budget rather than
// guessing at a larger one.

import "server-only";

import { redis } from "@/lib/redis/client";
import {
  createLockToken,
  releaseLockScript,
  startLockHeartbeat,
} from "@/lib/locking/redis-lock";

const LOCK_TTL_MS = 5000; // 5 seconds

function lockKey(runId: string) {
  return `run_lock:${runId}`;
}

/**
 * Attempts to acquire an exclusive lock for a specific workflow run.
 * Returns a unique token if successful, or null if the lock is already held.
 *
 * A `null` return is COORDINATION, not failure: another evaluator owns this run.
 * Callers must distinguish it from a thrown Redis error, which is an
 * infrastructure fault that has to surface rather than be reported as "someone
 * else is already working on it" - the first is normal and needs a re-entry,
 * the second means nothing has been scheduled at all.
 */
export async function acquireLock(runId: string): Promise<string | null> {
  // The shared primitive's token generator, not a second one: the release and
  // renewal scripts below compare against whatever this returns, so the scheme
  // has to be defined in one place. `withTokenLock` cannot be used instead
  // because this lock is released by a later call rather than at the end of a
  // callback.
  const token = createLockToken();

  const acquired = await redis.set(lockKey(runId), token, {
    nx: true,
    px: LOCK_TTL_MS,
  });

  if (acquired === "OK") {
    return token;
  }

  return null; // Someone else holds the lock
}

/**
 * Releases the lock, but ONLY if the token matches.
 * This prevents a slow worker from accidentally deleting the lock of a new worker.
 */
export async function releaseLock(runId: string, token: string): Promise<void> {
  await redis.eval(releaseLockScript, [lockKey(runId)], [token]);
}

/**
 * Keep the run lock alive for as long as the evaluator's work runs.
 *
 * Re-exported rather than reimplemented so the workflow evaluator and the agent
 * locks share one heartbeat. See `@/lib/locking/redis-lock` for why the token
 * check is inside the script rather than around it.
 */
export function startRunLockHeartbeat(runId: string, token: string) {
  return startLockHeartbeat({
    key: lockKey(runId),
    token,
    ttlMs: LOCK_TTL_MS,
  });
}
