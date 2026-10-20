// src/lib/security/seed-password.ts
//
// S12 (security) — the seed script creates real users with a real password
// hash. That password is a credential, so it must never be a hardcoded literal
// that a careless production seed would silently reuse.
//
// This resolver is the single place that decides which password a seed run may
// use, and it fails CLOSED: the only ways to get a password are
//
//   1. `SEED_PASSWORD` is configured (any environment), or
//   2. the caller EXPLICITLY opts into an isolated local-only mechanism by
//      setting `ALLOW_INSECURE_SEED=true`, in which case a fixed dev password is
//      returned.
//
// In every other case it throws, so a production seed without configuration
// aborts instead of planting a known credential.
//
// The opt-in mirrors the established convention in `src/lib/events/worker.ts`
// (`ALLOW_UNSIGNED_LOCAL_WORKER`): an explicit, exact-value named flag rather
// than a `NODE_ENV` check, because an environment NAME must not be the security
// boundary. Because the local mechanism plants a KNOWN password, it is refused
// outright when `NODE_ENV === "production"`, so even the explicit opt-in cannot
// weaken production. The stored/generated password is never logged.

/** The fixed password used by the isolated local-only path. */
export const INSECURE_LOCAL_SEED_PASSWORD = "forge-local-seed";

/** The environment shape this resolver reads. Kept narrow for testability. */
export type SeedEnv = {
  SEED_PASSWORD?: string;
  ALLOW_INSECURE_SEED?: string;
  NODE_ENV?: string;
};

/**
 * Resolve the password a seed run may use, or throw to fail closed.
 *
 * Returns the configured/opted-in password (never logs it). Throws with a
 * non-disclosing message when no safe source exists or when an unsafe
 * production configuration is detected.
 */
export function resolveSeedPassword(env: SeedEnv = process.env): string {
  // A configured credential is always honoured. Trim so a whitespace-only value
  // is treated as "not configured" rather than as a usable blank password.
  const configured = env.SEED_PASSWORD?.trim();
  if (configured) {
    return configured;
  }

  if (env.ALLOW_INSECURE_SEED === "true") {
    // The local mechanism plants a KNOWN password. Refuse it in production even
    // when explicitly requested: the point of the flag is local isolation, not
    // a production escape hatch.
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Refusing to seed with the insecure local password in production. " +
          "Configure SEED_PASSWORD instead.",
      );
    }
    return INSECURE_LOCAL_SEED_PASSWORD;
  }

  throw new Error(
    "No seed password configured. Set SEED_PASSWORD to seed users, or set " +
      "ALLOW_INSECURE_SEED=true for an isolated local run.",
  );
}
