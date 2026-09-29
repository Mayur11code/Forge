// src/tests/workflow/helpers/redis-double.ts
//
// Controllable stand-in for the shared Redis lock client.
//
// The evaluator race is timing-dependent in production and must NOT be tested
// with timers. This double lets a test express the contention directly: `holdLock`
// puts the key in the state another worker would hold it in, and the test drives
// the losing pass explicitly. Nothing here sleeps, so the test is deterministic
// and the failure it reproduces is the one that actually ships.
//
// Stands in for `@/lib/redis/client`, which is what the workflow mutex uses.

type LockEntry = { token: string; expiresAt: number };

const NO_EXPIRY = Number.POSITIVE_INFINITY;

export const redisState = {
  locks: new Map<string, LockEntry>(),
};

export function resetRedisDouble(): void {
  redisState.locks.clear();
}

/**
 * Put the key in the state another worker would hold it in.
 *
 * A distinct token matters: the mutex releases by compare-and-delete, so a
 * double that stored the caller's own token would let `releaseLock` delete a
 * lock the caller never acquired, and the test would pass while proving the
 * opposite of what it claims.
 */
export function holdLock(key: string, token = "another-worker"): void {
  redisState.locks.set(key, { token, expiresAt: NO_EXPIRY });
}

export function isLocked(key: string): boolean {
  return redisState.locks.has(key);
}

export function currentToken(key: string): string | null {
  return redisState.locks.get(key)?.token ?? null;
}

/** Drop a TTL as the clock would, so expiry-driven behaviour can be exercised. */
function expireIfDue(key: string): void {
  const entry = redisState.locks.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    redisState.locks.delete(key);
  }
}

const set = jest.fn(
  async (key: string, value: string, opts?: { nx?: boolean; px?: number }) => {
    expireIfDue(key);

    if (opts?.nx && redisState.locks.has(key)) {
      return null;
    }

    redisState.locks.set(key, {
      token: value,
      expiresAt: opts?.px ? Date.now() + opts.px : NO_EXPIRY,
    });

    return "OK";
  },
);

/**
 * Lua shim covering the two scripts the workflow mutex issues: token-guarded
 * release (DEL) and, once the heartbeat lands, token-guarded renewal (PEXPIRE).
 *
 * The token check is honoured in both directions. A renewal by a caller that no
 * longer owns the key must report failure rather than extend someone else's
 * lock, which is the exact bug the agent lock already documents.
 */
const evalScript = jest.fn(
  async (script: string, keys: string[], argv: string[]) => {
    const key = keys[0];
    const token = argv[0];

    expireIfDue(key);

    const entry = redisState.locks.get(key);
    if (!entry || entry.token !== token) {
      return 0;
    }

    if (/pexpire/i.test(script)) {
      entry.expiresAt = Date.now() + Number(argv[1]);
      return 1;
    }

    redisState.locks.delete(key);
    return 1;
  },
);

export const redisDouble = {
  set,
  eval: evalScript,
};

export function restoreRedisDouble(): void {
  set.mockClear();
  evalScript.mockClear();
}
