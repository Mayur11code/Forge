// src/tests/security/rate-limit.live.test.ts
//
// Dedicated, opt-in live integration test suite for H3 Upstash Redis rate limiting.
// Exercises real sliding-window enforcement, token-bucket admission, shared quota across
// independent limiter instances, Forge wrapper multi-scope evaluation, and fail-closed boundaries.
//
// Execution requirement:
//   npm run test:rate-limit:live
//
// Safety gates:
//   - Requires FORGE_LIVE_RATE_LIMIT_TESTS="true"
//   - Requires FORGE_LIVE_REDIS_CONFIRM_TEST_ENV="true" | "staging" | "test"
//   - Requires dedicated FORGE_LIVE_REDIS_REST_URL and FORGE_LIVE_REDIS_REST_TOKEN
//   - Host must NOT match application UPSTASH_REDIS_REST_URL
//   - If prerequisites are not met, zero Redis writes are made and actionable guidance is reported.

jest.mock("server-only", () => ({}));

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  checkRateLimit,
  createRateLimitResponse,
  type RateLimitPolicyConfig,
} from "@/lib/security/rate-limit";
import { validateLiveRedisEnvironment } from "./helpers/live-redis-guard";

// Set Jest timeout for live network round-trips and refill delay (30 seconds)
jest.setTimeout(30_000);

const guard = validateLiveRedisEnvironment();

describe("H3 Live Upstash Rate Limiting Integration Suite", () => {
  if (!guard.canRun) {
    it("reports live test execution prerequisites and skips live network calls", () => {
      console.warn("================================================================================");
      console.warn("LIVE TESTS NOT EXECUTED — ISOLATED TEST REDIS CONFIGURATION REQUIRED");
      console.warn(`Reason: ${guard.reason}`);
      guard.details.forEach((d) => console.warn(`  - ${d}`));
      console.warn("Zero Redis writes were performed.");
      console.warn("To run live tests, configure an isolated non-production Upstash Redis instance:");
      console.warn("  export FORGE_LIVE_RATE_LIMIT_TESTS=true");
      console.warn("  export FORGE_LIVE_REDIS_CONFIRM_TEST_ENV=test");
      console.warn("  export FORGE_LIVE_REDIS_REST_URL=https://dedicated-test-redis.upstash.io");
      console.warn("  export FORGE_LIVE_REDIS_REST_TOKEN=your-dedicated-test-token");
      console.warn("================================================================================");

      expect(guard.canRun).toBe(false);
      expect(guard.reason).toBeDefined();
      expect(guard.details.length).toBeGreaterThan(0);
    });
    return;
  }

  // The following tests only execute when the dedicated test environment is validated.
  const { client: testRedis, runId } = guard.config!;

  // ---------------------------------------------------------------------------
  // Test A — Real sliding-window enforcement
  // ---------------------------------------------------------------------------
  describe("Test A — Real sliding-window enforcement", () => {
    it("enforces small sliding window, rejects 3rd request, and confirms non-consuming reads", async () => {
      const prefix = `@forge/live-test:rl:${runId}:testA_sw`;
      const limiter = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(2, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const idA1 = `test_u_${runId}_1`;

      // 1. First request -> permitted
      const res1 = await limiter.limit(idA1);
      expect(res1.success).toBe(true);
      expect(res1.limit).toBe(2);
      expect(res1.remaining).toBe(1);

      // 2. Second request -> permitted (exhausts budget)
      const res2 = await limiter.limit(idA1);
      expect(res2.success).toBe(true);
      expect(res2.remaining).toBe(0);

      // 3. Third request -> rejected
      const res3 = await limiter.limit(idA1);
      expect(res3.success).toBe(false);
      expect(res3.limit).toBe(2);
      expect(res3.remaining).toBe(0);
      expect(res3.reset).toBeGreaterThan(Date.now());

      // 4. getRemaining does NOT consume quota
      const status1 = await limiter.getRemaining(idA1);
      expect(status1.remaining).toBe(0);
      expect(status1.limit).toBe(2);

      const status2 = await limiter.getRemaining(idA1);
      expect(status2.remaining).toBe(0);

      // 5. Independent identifier does NOT share counter
      const idA2 = `test_u_${runId}_2`;
      const resOther = await limiter.limit(idA2);
      expect(resOther.success).toBe(true);
      expect(resOther.remaining).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test B — Real token-bucket admission and refill
  // ---------------------------------------------------------------------------
  describe("Test B — Real token-bucket admission and refill", () => {
    it("admits bursts up to capacity, rejects immediate excess, and refills after interval", async () => {
      const prefix = `@forge/live-test:rl:${runId}:testB_tb`;
      // Capacity: 2 tokens, refill: 1 token every 2 seconds
      const limiter = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.tokenBucket(1, "2 s", 2),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const idB = `test_tb_${runId}`;

      // 1. Consume 1st token
      const res1 = await limiter.limit(idB);
      expect(res1.success).toBe(true);
      expect(res1.limit).toBe(2);
      expect(res1.remaining).toBe(1);

      // 2. Consume 2nd token
      const res2 = await limiter.limit(idB);
      expect(res2.success).toBe(true);
      expect(res2.remaining).toBe(0);

      // 3. 3rd immediate request rejected
      const res3 = await limiter.limit(idB);
      expect(res3.success).toBe(false);
      expect(res3.remaining).toBe(0);
      expect(res3.reset).toBeGreaterThan(Date.now());

      // 4. Status read does not consume admission tokens
      const status = await limiter.getRemaining(idB);
      expect(status.remaining).toBe(0);

      // 5. Wait for refill interval (2200ms)
      await new Promise((resolve) => setTimeout(resolve, 2200));

      // 6. Request accepted after refill
      const resRefilled = await limiter.limit(idB);
      expect(resRefilled.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test C — Shared quota across independent instances
  // ---------------------------------------------------------------------------
  describe("Test C — Shared quota across independent instances", () => {
    it("shares persistent quota state across separate instances with no in-memory cache", async () => {
      const prefix = `@forge/live-test:rl:${runId}:testC_shared`;

      // Construct two independent instances pointing to the same backend
      const instanceA = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(5, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const instanceB = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(5, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const idShared = `test_shared_${runId}`;

      // Instance A sends 3 requests
      const rA1 = await instanceA.limit(idShared);
      const rA2 = await instanceA.limit(idShared);
      const rA3 = await instanceA.limit(idShared);
      expect(rA1.success).toBe(true);
      expect(rA2.success).toBe(true);
      expect(rA3.success).toBe(true);

      // Instance B sends 2 requests (exhausts shared 5-token budget)
      const rB1 = await instanceB.limit(idShared);
      const rB2 = await instanceB.limit(idShared);
      expect(rB1.success).toBe(true);
      expect(rB2.success).toBe(true);
      expect(rB2.remaining).toBe(0);

      // Both instances now reject
      const rA4 = await instanceA.limit(idShared);
      const rB3 = await instanceB.limit(idShared);
      expect(rA4.success).toBe(false);
      expect(rB3.success).toBe(false);

      // Recreating a 3rd instance does NOT reset quota (persisted in Redis)
      const instanceC = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(5, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });
      const rC = await instanceC.limit(idShared);
      expect(rC.success).toBe(false);
    });

    it("evaluates bounded concurrent requests atomically in Redis", async () => {
      const prefix = `@forge/live-test:rl:${runId}:testC_concurrent`;

      const limiterA = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(5, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const limiterB = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(5, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const idConcurrent = `test_concurrent_${runId}`;

      // 20 concurrent requests racing against limit of 5
      const promises = Array.from({ length: 20 }, (_, idx) =>
        (idx % 2 === 0 ? limiterA : limiterB).limit(idConcurrent)
      );

      const results = await Promise.all(promises);
      const accepted = results.filter((r) => r.success);
      const rejected = results.filter((r) => !r.success);

      // In single-region Upstash Redis, Lua script executes atomically
      expect(accepted.length).toBe(5);
      expect(rejected.length).toBe(15);
    });
  });

  // ---------------------------------------------------------------------------
  // Test D — Real Forge wrapper integration
  // ---------------------------------------------------------------------------
  describe("Test D — Real Forge wrapper integration", () => {
    it("enforces multi-scope user and org policies via checkRateLimit", async () => {
      const testPolicy: RateLimitPolicyConfig = {
        name: "TEST_WRAPPER_LIVE_SW",
        category: "request_sliding_window",
        algorithm: "sliding_window",
        prefix: `@forge/live-test:rl:${runId}:wrap_sw`,
        failClosed: false,
        timeoutMs: 2500,
        userLimit: {
          limit: 2,
          windowOrInterval: "60 s",
        },
        orgLimit: {
          limit: 3,
          windowOrInterval: "60 s",
        },
      };

      const user1 = `u_${runId}_1`;
      const user2 = `u_${runId}_2`;
      const user3 = `u_${runId}_3`;
      const orgA = `org_${runId}_A`;
      const orgB = `org_${runId}_B`;

      // User 1 under Org A: call 1 -> OK
      const u1_1 = await checkRateLimit({
        policy: testPolicy,
        userId: user1,
        orgId: orgA,
        redis: testRedis,
      });
      expect(u1_1.allowed).toBe(true);
      expect(u1_1.status).toBe(200);

      // User 1 under Org A: call 2 -> OK (User 1 exhausted, Org A has 2/3)
      const u1_2 = await checkRateLimit({
        policy: testPolicy,
        userId: user1,
        orgId: orgA,
        redis: testRedis,
      });
      expect(u1_2.allowed).toBe(true);

      // User 1 under Org A: call 3 -> Blocked by User limit
      const u1_3 = await checkRateLimit({
        policy: testPolicy,
        userId: user1,
        orgId: orgA,
        redis: testRedis,
      });
      expect(u1_3.allowed).toBe(false);
      expect(u1_3.status).toBe(429);
      expect(u1_3.headers["Retry-After"]).toBeDefined();

      // User 2 under Org A: call 1 -> OK (Org A now has 3/3 consumed)
      const u2_1 = await checkRateLimit({
        policy: testPolicy,
        userId: user2,
        orgId: orgA,
        redis: testRedis,
      });
      expect(u2_1.allowed).toBe(true);

      // User 2 under Org A: call 2 -> Blocked by Org limit
      const u2_2 = await checkRateLimit({
        policy: testPolicy,
        userId: user2,
        orgId: orgA,
        redis: testRedis,
      });
      expect(u2_2.allowed).toBe(false);
      expect(u2_2.status).toBe(429);

      // User 3 under Org B: Org B has independent quota -> OK
      const u3_1 = await checkRateLimit({
        policy: testPolicy,
        userId: user3,
        orgId: orgB,
        redis: testRedis,
      });
      expect(u3_1.allowed).toBe(true);
      expect(u3_1.status).toBe(200);

      // Response construction returns compliant 429
      const httpResponse = createRateLimitResponse(u1_3);
      expect(httpResponse.status).toBe(429);
      expect(httpResponse.headers.get("Retry-After")).toBeDefined();
      expect(httpResponse.headers.get("X-RateLimit-Limit")).toBeDefined();
    });

    it("enforces token-bucket policy via checkRateLimit", async () => {
      const tbPolicy: RateLimitPolicyConfig = {
        name: "TEST_WRAPPER_LIVE_TB",
        category: "ai_admission",
        algorithm: "token_bucket",
        prefix: `@forge/live-test:rl:${runId}:wrap_tb`,
        failClosed: true,
        timeoutMs: 2500,
        userLimit: {
          limit: 2,
          windowOrInterval: "2 s",
          refillRate: 1,
        },
      };

      const user = `u_tb_${runId}`;

      const r1 = await checkRateLimit({
        policy: tbPolicy,
        userId: user,
        redis: testRedis,
      });
      expect(r1.allowed).toBe(true);

      const r2 = await checkRateLimit({
        policy: tbPolicy,
        userId: user,
        redis: testRedis,
      });
      expect(r2.allowed).toBe(true);

      const r3 = await checkRateLimit({
        policy: tbPolicy,
        userId: user,
        redis: testRedis,
      });
      expect(r3.allowed).toBe(false);
      expect(r3.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Test E — Failure handling boundaries
  // ---------------------------------------------------------------------------
  describe("Test E — Failure handling boundaries", () => {
    it("distinguishes quota exhaustion (429) from fail-closed error (503)", async () => {
      const failClosedPolicy: RateLimitPolicyConfig = {
        name: "TEST_FAIL_CLOSED_LIVE",
        category: "ai_admission",
        algorithm: "token_bucket",
        prefix: `@forge/live-test:rl:${runId}:fail_closed`,
        failClosed: true,
        timeoutMs: 500,
        userLimit: {
          limit: 5,
          windowOrInterval: "1 m",
          refillRate: 1,
        },
      };

      // Unreachable test-only endpoint with zero retries
      const deadRedis = new Redis({
        url: "https://127.0.0.1:9",
        token: "test-token-unreachable",
        retry: { retries: 0 },
      });

      const failureResult = await checkRateLimit({
        policy: failClosedPolicy,
        userId: `u_${runId}_fail`,
        redis: deadRedis,
      });

      expect(failureResult.allowed).toBe(false);
      expect(failureResult.status).toBe(503);
      expect(failureResult.error).toBe("RATE_LIMITER_UNAVAILABLE");

      // Verify fail-open policy returns 200 on same unreachable client
      const failOpenPolicy: RateLimitPolicyConfig = {
        name: "TEST_FAIL_OPEN_LIVE",
        category: "request_sliding_window",
        algorithm: "sliding_window",
        prefix: `@forge/live-test:rl:${runId}:fail_open`,
        failClosed: false,
        timeoutMs: 500,
        userLimit: {
          limit: 5,
          windowOrInterval: "1 m",
        },
      };

      const failOpenResult = await checkRateLimit({
        policy: failOpenPolicy,
        userId: `u_${runId}_open`,
        redis: deadRedis,
      });

      expect(failOpenResult.allowed).toBe(true);
      expect(failOpenResult.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Test F — Latency measurement & instance lifecycle
  // ---------------------------------------------------------------------------
  describe("Test F — Latency measurement & instance lifecycle", () => {
    it("measures round-trip latency across sequential live calls and records stats", async () => {
      const prefix = `@forge/live-test:rl:${runId}:testF_latency`;
      const limiter = new Ratelimit({
        redis: testRedis,
        limiter: Ratelimit.slidingWindow(20, "60 s"),
        prefix,
        ephemeralCache: false,
        analytics: false,
      });

      const latencies: number[] = [];
      const sampleCount = 8;

      for (let i = 0; i < sampleCount; i++) {
        const start = performance.now();
        await limiter.limit(`lat_u_${runId}_${i}`);
        const duration = performance.now() - start;
        latencies.push(duration);
      }

      latencies.sort((a, b) => a - b);
      const median = latencies[Math.floor(latencies.length / 2)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const min = latencies[0];
      const max = latencies[latencies.length - 1];

      console.info(
        `[LIVE_TEST_LATENCY] Samples: ${sampleCount}, Min: ${min.toFixed(1)}ms, Median: ${median.toFixed(1)}ms, p95: ${p95.toFixed(1)}ms, Max: ${max.toFixed(1)}ms`
      );

      expect(latencies.length).toBe(sampleCount);
      expect(median).toBeGreaterThan(0);
    });
  });
});
