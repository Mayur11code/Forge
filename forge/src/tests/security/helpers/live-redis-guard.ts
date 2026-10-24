// src/tests/security/helpers/live-redis-guard.ts
//
// Safety validator and environment prerequisite checker for live Upstash Redis rate-limiting tests.
// Enforces that live network tests only execute when explicit opt-in, dedicated test credentials,
// test-environment confirmation, and host isolation from the application Redis are verified.

import { Redis } from "@upstash/redis";

export interface LiveRedisGuardResult {
  canRun: boolean;
  reason?: string;
  details: string[];
  config?: {
    url: string;
    token: string;
    confirmEnv: string;
    runId: string;
    client: Redis;
  };
}

/**
 * Validates the runtime environment against Forge's safety invariants before making live Redis calls.
 *
 * Safety requirements:
 * 1. NODE_ENV !== "production".
 * 2. FORGE_LIVE_RATE_LIMIT_TESTS === "true" (explicit opt-in).
 * 3. FORGE_LIVE_REDIS_CONFIRM_TEST_ENV === "true" | "staging" | "test".
 * 4. FORGE_LIVE_REDIS_REST_URL must be a valid http/https URL.
 * 5. FORGE_LIVE_REDIS_REST_TOKEN must be non-empty.
 * 6. Never fall back to UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
 * 7. If UPSTASH_REDIS_REST_URL is configured, FORGE_LIVE_REDIS_REST_URL hostname must NOT match it.
 */
export function validateLiveRedisEnvironment(
  env: NodeJS.ProcessEnv = process.env
): LiveRedisGuardResult {
  const details: string[] = [];

  // 1. Non-production execution check
  if (env.NODE_ENV === "production") {
    return {
      canRun: false,
      reason: "Live rate-limit integration tests cannot run when NODE_ENV is 'production'",
      details: ["NODE_ENV=production detected. Aborting to prevent any test execution in production."],
    };
  }

  // 2. Explicit opt-in flag
  const optIn = env.FORGE_LIVE_RATE_LIMIT_TESTS;
  if (optIn !== "true") {
    details.push("FORGE_LIVE_RATE_LIMIT_TESTS must be explicitly set to 'true'.");
  }

  // 3. Staging/test environment confirmation
  const confirmEnv = env.FORGE_LIVE_REDIS_CONFIRM_TEST_ENV;
  if (!confirmEnv || (confirmEnv !== "true" && confirmEnv !== "staging" && confirmEnv !== "test")) {
    details.push(
      "FORGE_LIVE_REDIS_CONFIRM_TEST_ENV must be set to 'true', 'staging', or 'test' to confirm non-production target."
    );
  }

  // 4. Test-specific URL & token (requires dedicated credentials or explicit dev database opt-in)
  const allowDevRedis = env.FORGE_LIVE_ALLOW_DEV_REDIS === "true";

  let testUrl = env.FORGE_LIVE_REDIS_REST_URL;
  let testToken = env.FORGE_LIVE_REDIS_REST_TOKEN;

  if ((!testUrl || !testToken) && allowDevRedis) {
    testUrl = env.UPSTASH_REDIS_REST_URL;
    testToken = env.UPSTASH_REDIS_REST_TOKEN;
  }

  if (!testUrl || testUrl.trim().length === 0) {
    details.push(
      "FORGE_LIVE_REDIS_REST_URL is missing. A dedicated test Upstash Redis REST URL is required (or set FORGE_LIVE_ALLOW_DEV_REDIS=true to confirm use of development database)."
    );
  } else {
    try {
      const parsed = new URL(testUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        details.push("Test Redis REST URL must use http: or https: protocol.");
      }
    } catch {
      details.push("Test Redis REST URL is not a valid URL.");
    }
  }

  if (!testToken || testToken.trim().length === 0) {
    details.push("FORGE_LIVE_REDIS_REST_TOKEN is missing or empty.");
  }

  // 5. Host isolation check against application Redis (enforced unless explicit dev database opt-in is granted)
  const appUrl = env.UPSTASH_REDIS_REST_URL;
  if (!allowDevRedis && appUrl && testUrl) {
    try {
      const appParsed = new URL(appUrl);
      const testParsed = new URL(testUrl);
      if (appParsed.hostname.toLowerCase() === testParsed.hostname.toLowerCase()) {
        details.push(
          `FORGE_LIVE_REDIS_REST_URL points to the same host as UPSTASH_REDIS_REST_URL (${testParsed.hostname}). A genuinely dedicated test Redis instance is required (or set FORGE_LIVE_ALLOW_DEV_REDIS=true to permit development Redis).`
        );
      }
    } catch {
      // Ignore URL parsing errors here as testUrl format is validated above
    }
  }

  if (details.length > 0) {
    return {
      canRun: false,
      reason: "Missing or invalid dedicated test Redis prerequisites",
      details,
    };
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const client = new Redis({
    url: testUrl!,
    token: testToken!,
    retry: { retries: 1 },
  });

  return {
    canRun: true,
    details: [],
    config: {
      url: testUrl!,
      token: testToken!,
      confirmEnv: confirmEnv!,
      runId,
      client,
    },
  };
}
