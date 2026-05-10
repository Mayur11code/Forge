// src/lib/workflow/execution/mutex.ts
import { Redis } from '@upstash/redis';

// Initializes connection using UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from .env
const redis = Redis.fromEnv();

const LOCK_TTL_MS = 5000; // 5 seconds

/**
 * Attempts to acquire an exclusive lock for a specific workflow run.
 * Returns a unique token if successful, or null if the lock is already held.
 */
export async function acquireLock(runId: string): Promise<string | null> {
  const lockKey = `run_lock:${runId}`;
  
  // We generate a unique token for THIS specific worker instance
  const token = crypto.randomUUID();

  // SETNX: "Set if Not eXists". This is an atomic operation in Redis.
  // px: Expire the lock automatically after 5000ms.
  const acquired = await redis.set(lockKey, token, {
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
  const lockKey = `run_lock:${runId}`;

  // We use a Lua script to ensure the read-and-delete is 100% atomic.
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  await redis.eval(script, [lockKey], [token]);
}