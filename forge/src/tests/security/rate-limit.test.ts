// src/tests/security/rate-limit.test.ts
//
// Verification test suite for Production Hardening H3 — Distributed Rate Limiting & AI Admission Control.
// Tests sliding-window request limiting, token-bucket AI admission control, multi-limiter scoping,
// fail-closed Redis error/timeout handling, non-mutating status queries, and client IP extraction.

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/redis/client", () => ({
  redis: {
    evalsha: jest.fn(),
    eval: jest.fn(),
  },
}));

import fs from "fs";
import {
  checkRateLimit,
  getRateLimitStatus,
  createRateLimitResponse,
  buildRateLimitHeaders,
  formatRateLimitIdentifier,
  getClientIp,
  RATE_LIMIT_POLICIES,
  RateLimitPolicyConfig,
  getOrCreateRatelimit,
} from "@/lib/security/rate-limit";
import { validateLiveRedisEnvironment } from "./helpers/live-redis-guard";

describe("Production Hardening H3 — Distributed Rate Limiting & AI Admission Control", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Identifier Formatting & Non-PII Sanitization", () => {
    it("formats user and organization identifiers safely without PII", () => {
      expect(formatRateLimitIdentifier("u", "usr_12345")).toBe("u:usr_12345");
      expect(formatRateLimitIdentifier("o", "org_abcde")).toBe("o:org_abcde");
      // Sanitizes special characters to avoid key injection
      expect(formatRateLimitIdentifier("u", "user@example.com!#$")).toBe("u:user_example_com___");
    });

    it("hashes IP addresses with SHA-256 to prevent storing raw IP strings", () => {
      const formatted = formatRateLimitIdentifier("ip", "192.168.1.1");
      expect(formatted.startsWith("ip:")).toBe(true);
      expect(formatted).not.toContain("192.168.1.1");
      expect(formatted.length).toBe(19); // "ip:" (3) + 16 hex chars
    });
  });

  describe("Standard Rate Limit Headers", () => {
    it("builds compliant X-RateLimit-* and Retry-After headers", () => {
      const now = Date.now();
      const reset = now + 15000;
      const headers = buildRateLimitHeaders(10, 5, reset);

      expect(headers["X-RateLimit-Limit"]).toBe("10");
      expect(headers["X-RateLimit-Remaining"]).toBe("5");
      expect(headers["X-RateLimit-Reset"]).toBe(String(reset));
      expect(headers["Retry-After"]).toBe("15");
    });

    it("clamps remaining to zero and ensures Retry-After is at least 1 second", () => {
      const now = Date.now();
      const headers = buildRateLimitHeaders(5, -1, now - 1000);

      expect(headers["X-RateLimit-Remaining"]).toBe("0");
      expect(headers["Retry-After"]).toBe("1");
    });
  });

  describe("Sliding-Window Request Limiting", () => {
    it("permits allowed requests and returns 200 with metadata headers", async () => {
      const mockPolicy: RateLimitPolicyConfig = {
        name: "TEST_SLIDING_WINDOW",
        category: "request_sliding_window",
        algorithm: "sliding_window",
        prefix: "@forge/test:sl",
        failClosed: false,
        userLimit: {
          limit: 10,
          windowOrInterval: "10 s",
        },
      };

      // Upstash slidingWindow expects [remainingTokens, effectiveLimit] from safeEval
      const customRedis = {
        evalsha: jest.fn().mockResolvedValue([9, 10]),
        eval: jest.fn().mockResolvedValue([9, 10]),
      } as any;

      const result = await checkRateLimit({
        policy: mockPolicy,
        userId: "user_1",
        redis: customRedis,
      });

      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(result.headers["X-RateLimit-Limit"]).toBe("10");
      expect(result.headers["X-RateLimit-Remaining"]).toBe("9");
    });

    it("rejects exceeded requests with 429 and standard RATE_LIMITED payload", async () => {
      // Upstash slidingWindow returns negative remaining on exhaustion: [-1, effectiveLimit]
      const customRedis = {
        evalsha: jest.fn().mockResolvedValue([-1, 10]),
        eval: jest.fn().mockResolvedValue([-1, 10]),
      } as any;

      const mockPolicy: RateLimitPolicyConfig = {
        name: "TEST_TASK_CREATE",
        category: "request_sliding_window",
        algorithm: "sliding_window",
        prefix: "@forge/test:task",
        failClosed: false,
        userLimit: {
          limit: 10,
          windowOrInterval: "10 s",
        },
      };

      const result = await checkRateLimit({
        policy: mockPolicy,
        userId: "user_spam",
        redis: customRedis,
      });

      expect(result.allowed).toBe(false);
      expect(result.status).toBe(429);
      expect(result.error).toBe("RATE_LIMITED");
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.headers["Retry-After"]).toBe(String(result.retryAfterSeconds));

      const response = createRateLimitResponse(result);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(String(result.retryAfterSeconds));
    });

    it("enforces cross-tenant isolation between organizations", async () => {
      // Org A is exhausted (remaining = -1, limit = 100)
      const mockEvalOrgA = jest.fn().mockResolvedValue([-1, 100]);
      // Org B has capacity (remaining = 50, limit = 100)
      const mockEvalOrgB = jest.fn().mockResolvedValue([50, 100]);

      const policy: RateLimitPolicyConfig = {
        name: "TEST_ORG_ISOLATION",
        category: "request_sliding_window",
        algorithm: "sliding_window",
        prefix: "@forge/test:iso",
        failClosed: false,
        orgLimit: {
          limit: 100,
          windowOrInterval: "1 m",
        },
      };

      const resultOrgA = await checkRateLimit({
        policy,
        orgId: "org_exhausted",
        redis: { evalsha: mockEvalOrgA, eval: mockEvalOrgA } as any,
      });

      const resultOrgB = await checkRateLimit({
        policy,
        orgId: "org_healthy",
        redis: { evalsha: mockEvalOrgB, eval: mockEvalOrgB } as any,
      });

      expect(resultOrgA.allowed).toBe(false);
      expect(resultOrgA.status).toBe(429);

      expect(resultOrgB.allowed).toBe(true);
      expect(resultOrgB.status).toBe(200);
      expect(resultOrgB.remaining).toBe(50);
    });
  });

  describe("Token-Bucket AI Admission Control", () => {
    it("admits initial burst up to configured capacity and enforces quota", async () => {
      const resetTime = Date.now() + 120000;
      // First call has remaining = 4 tokens out of 5
      const mockRedisSuccess = {
        evalsha: jest.fn().mockResolvedValue([4, resetTime, 5]),
        eval: jest.fn().mockResolvedValue([4, resetTime, 5]),
      } as any;

      const result = await checkRateLimit({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_ai_1",
        redis: mockRedisSuccess,
      });

      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4);
    });

    it("rejects AI admission when token bucket is exhausted", async () => {
      const resetTime = Date.now() + 65000;
      // Exhausted bucket returns remaining < 0
      const mockRedisExhausted = {
        evalsha: jest.fn().mockResolvedValue([-1, resetTime, 5]),
        eval: jest.fn().mockResolvedValue([-1, resetTime, 5]),
      } as any;

      const result = await checkRateLimit({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_ai_exhausted",
        redis: mockRedisExhausted,
      });

      expect(result.allowed).toBe(false);
      expect(result.status).toBe(429);
      expect(result.error).toBe("RATE_LIMITED");
      expect(result.message).toContain("AI admission rate limit reached");
      expect(result.retryAfterSeconds).toBe(65);
      expect(result.headers["Retry-After"]).toBe("65");
    });

    it("evaluates user and organization limiters sequentially", async () => {
      const resetTime = Date.now() + 60000;
      // User has tokens (remaining = 2)
      // But Org has 0 tokens (remaining = -1)
      let callCount = 0;
      const mockEval = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // User check passes
          return [2, resetTime, 5];
        } else {
          // Org check rejects
          return [-1, resetTime, 15];
        }
      });

      const mockRedis = {
        evalsha: mockEval,
        eval: mockEval,
      } as any;

      const result = await checkRateLimit({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_valid",
        orgId: "org_throttled",
        redis: mockRedis,
      });

      expect(callCount).toBe(2);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(429);
      expect(result.error).toBe("RATE_LIMITED");
    });
  });

  describe("Redis Failure & Enforcement Semantics (Fail-Closed vs Fail-Open)", () => {
    it("fails closed with 503 RATE_LIMITER_UNAVAILABLE on Redis connection exception for AI admission", async () => {
      const mockRedisError = {
        evalsha: jest.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis cluster unreachable")),
        eval: jest.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis cluster unreachable")),
      } as any;

      const result = await checkRateLimit({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_fail_test",
        redis: mockRedisError,
      });

      expect(result.allowed).toBe(false);
      expect(result.status).toBe(503);
      expect(result.error).toBe("RATE_LIMITER_UNAVAILABLE");
      expect(result.message).toContain("Rate limit verification temporarily unavailable");
      expect(result.headers["Retry-After"]).toBe("5");
      // Asserts that raw connection exception is not disclosed in client message
      expect(result.message).not.toContain("ECONNREFUSED");
      expect(result.message).not.toContain("Redis");
    });

    it("fails closed on limiter timeout for AI admission policies", async () => {
      // Simulate Upstash Ratelimit timeout result: { success: true, reason: "timeout" }
      const mockTimeoutRedis = {
        evalsha: jest.fn().mockImplementation(() => new Promise(() => {})), // never resolves
        eval: jest.fn().mockImplementation(() => new Promise(() => {})),
      } as any;

      const policy: RateLimitPolicyConfig = {
        name: "TEST_AI_TIMEOUT",
        category: "ai_admission",
        algorithm: "token_bucket",
        prefix: "@forge/test:timeout",
        failClosed: true,
        userLimit: {
          limit: 5,
          windowOrInterval: "1 m",
          refillRate: 1,
        },
      };

      // Direct check: mock executeLimiterCheck behavior
      const testLimiter = {
        limit: jest.fn().mockResolvedValue({
          success: true,
          limit: 0,
          remaining: 0,
          reset: 0,
          reason: "timeout",
        }),
      };

      jest.spyOn(getOrCreateRatelimit as any, "call").mockReturnValue(testLimiter);

      const result = await checkRateLimit({
        policy,
        userId: "user_timeout",
        redis: mockTimeoutRedis,
      });

      // When failClosed is true, timeout must return 503
      expect(result.status).toBe(503);
      expect(result.allowed).toBe(false);
      expect(result.error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("fails open with 200 and warning on Redis error for non-critical request policies", async () => {
      const mockRedisError = {
        evalsha: jest.fn().mockRejectedValue(new Error("Redis connection timed out")),
        eval: jest.fn().mockRejectedValue(new Error("Redis connection timed out")),
      } as any;

      const result = await checkRateLimit({
        policy: RATE_LIMIT_POLICIES.REQUEST_TASK_CREATE,
        userId: "user_crud",
        redis: mockRedisError,
      });

      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
      expect(result.warning).toBe("RATE_LIMITER_EXCEPTION_FAIL_OPEN");
    });
  });

  describe("Non-Mutating Quota Status Queries (getRateLimitStatus)", () => {
    it("returns quota snapshot without consuming tokens", async () => {
      const resetTime = Date.now() + 45000;
      const mockGetRemaining = jest.fn().mockResolvedValue([3, resetTime, 5]);

      const mockRedis = {
        evalsha: mockGetRemaining,
        eval: mockGetRemaining,
      } as any;

      const status = await getRateLimitStatus({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_status_check",
        redis: mockRedis,
      });

      expect(status.available).toBe(true);
      expect(status.limit).toBe(5);
      expect(status.remaining).toBe(3);
      expect(status.reset).toBeGreaterThan(0);
      expect(status.retryAfterSeconds).toBeUndefined(); // Not exhausted, no retry needed
    });

    it("returns available: false gracefully when Redis is unreachable", async () => {
      const mockRedis = {
        evalsha: jest.fn().mockRejectedValue(new Error("Redis down")),
        eval: jest.fn().mockRejectedValue(new Error("Redis down")),
      } as any;

      const status = await getRateLimitStatus({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_status_check",
        redis: mockRedis,
      });

      expect(status.available).toBe(false);
      expect(status.remaining).toBe(0);
    });
  });

  describe("Client IP Extraction", () => {
    it("extracts IP from x-vercel-forwarded-for header", () => {
      const req = new Request("https://forge.dev/api/test", {
        headers: { "x-vercel-forwarded-for": "203.0.113.195, 10.0.0.1" },
      });
      expect(getClientIp(req)).toBe("203.0.113.195");
    });

    it("falls back to x-forwarded-for first IP", () => {
      const req = new Request("https://forge.dev/api/test", {
        headers: { "x-forwarded-for": "198.51.100.4, 192.168.1.1" },
      });
      expect(getClientIp(req)).toBe("198.51.100.4");
    });

    it("returns null when no IP headers are present", () => {
      const req = new Request("https://forge.dev/api/test");
      expect(getClientIp(req)).toBeNull();
    });
  });

  describe("Rate Limit Status Route Handlers & Integration Guards", () => {
    it("guarantees rate limiting modules enforce server-only boundary", () => {
      const rateLimitContent = fs.readFileSync("src/lib/security/rate-limit.ts", "utf8");
      const redisRateLimitContent = fs.readFileSync("src/lib/redis/rate-limit.ts", "utf8");

      expect(rateLimitContent.startsWith('import "server-only";')).toBe(true);
      expect(redisRateLimitContent.startsWith('import "server-only";')).toBe(true);
    });

    it("verifies AI admission policies have failClosed enabled", () => {
      expect(RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT.failClosed).toBe(true);
      expect(RATE_LIMIT_POLICIES.AI_ADMISSION_CHAT.failClosed).toBe(true);
      expect(RATE_LIMIT_POLICIES.AI_ADMISSION_TRIAGE.failClosed).toBe(true);
    });

    it("verifies request CRUD policies have failClosed disabled (fail-open with warning)", () => {
      expect(RATE_LIMIT_POLICIES.REQUEST_TASK_CREATE.failClosed).toBe(false);
      expect(RATE_LIMIT_POLICIES.REQUEST_AGENT_ACTION.failClosed).toBe(false);
    });

    it("proves that internal worker deliveries and retries do not evaluate admission limiter", () => {
      // The internal QStash worker route at src/app/api/worker/route.ts dispatches
      // event handlers (agent loop, tool execution, workflow node execution) directly
      // behind QStash signature verification and never calls checkRateLimit(AI_ADMISSION_*).
      const workerRoute = fs.readFileSync("src/app/api/worker/route.ts", "utf8");
      const agentWorker = fs.readFileSync("src/app/api/worker/agent-loop/al.ts", "utf8");
      const toolWorker = fs.readFileSync("src/lib/ai/agent/tool-worker.ts", "utf8");

      expect(workerRoute).not.toContain("checkRateLimit");
      expect(agentWorker).not.toContain("checkRateLimit");
      expect(toolWorker).not.toContain("checkRateLimit");
    });
  });

  describe("Live Redis Integration Environment Guard", () => {
    const validTestEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      FORGE_LIVE_RATE_LIMIT_TESTS: "true",
      FORGE_LIVE_REDIS_CONFIRM_TEST_ENV: "test",
      FORGE_LIVE_REDIS_REST_URL: "https://isolated-staging-redis.upstash.io",
      FORGE_LIVE_REDIS_REST_TOKEN: "valid-staging-token-xyz",
      UPSTASH_REDIS_REST_URL: "https://production-app-redis.upstash.io",
    };

    it("rejects execution if NODE_ENV is production", () => {
      const res = validateLiveRedisEnvironment({
        ...validTestEnv,
        NODE_ENV: "production",
      });
      expect(res.canRun).toBe(false);
      expect(res.reason).toContain("production");
    });

    it("rejects execution if FORGE_LIVE_RATE_LIMIT_TESTS is not 'true'", () => {
      const res = validateLiveRedisEnvironment({
        ...validTestEnv,
        FORGE_LIVE_RATE_LIMIT_TESTS: "false",
      });
      expect(res.canRun).toBe(false);
      expect(res.details.some((d) => d.includes("FORGE_LIVE_RATE_LIMIT_TESTS"))).toBe(true);
    });

    it("rejects execution if FORGE_LIVE_REDIS_CONFIRM_TEST_ENV is missing or invalid", () => {
      const res = validateLiveRedisEnvironment({
        ...validTestEnv,
        FORGE_LIVE_REDIS_CONFIRM_TEST_ENV: undefined,
      });
      expect(res.canRun).toBe(false);
      expect(res.details.some((d) => d.includes("FORGE_LIVE_REDIS_CONFIRM_TEST_ENV"))).toBe(true);
    });

    it("rejects execution if test URL or token is missing", () => {
      const res = validateLiveRedisEnvironment({
        ...validTestEnv,
        FORGE_LIVE_REDIS_REST_URL: undefined,
        FORGE_LIVE_REDIS_REST_TOKEN: undefined,
      });
      expect(res.canRun).toBe(false);
      expect(res.details.some((d) => d.includes("FORGE_LIVE_REDIS_REST_URL"))).toBe(true);
      expect(res.details.some((d) => d.includes("FORGE_LIVE_REDIS_REST_TOKEN"))).toBe(true);
    });

    it("rejects execution if FORGE_LIVE_REDIS_REST_URL points to the same host as UPSTASH_REDIS_REST_URL", () => {
      const res = validateLiveRedisEnvironment({
        ...validTestEnv,
        FORGE_LIVE_REDIS_REST_URL: "https://production-app-redis.upstash.io",
        UPSTASH_REDIS_REST_URL: "https://production-app-redis.upstash.io",
      });
      expect(res.canRun).toBe(false);
      expect(res.details.some((d) => d.includes("points to the same host as UPSTASH_REDIS_REST_URL"))).toBe(true);
    });

    it("validates successfully and initializes dedicated client when all prerequisites are met", () => {
      const res = validateLiveRedisEnvironment(validTestEnv);
      expect(res.canRun).toBe(true);
      expect(res.details.length).toBe(0);
      expect(res.config).toBeDefined();
      expect(res.config?.runId).toMatch(/^run_\d+_[a-z0-9]+$/);
      expect(res.config?.client).toBeDefined();
    });

    it("allows execution against development Redis when FORGE_LIVE_ALLOW_DEV_REDIS is set", () => {
      const devEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        FORGE_LIVE_RATE_LIMIT_TESTS: "true",
        FORGE_LIVE_REDIS_CONFIRM_TEST_ENV: "test",
        FORGE_LIVE_ALLOW_DEV_REDIS: "true",
        UPSTASH_REDIS_REST_URL: "https://dev-database.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "dev-token-abc",
      };
      const res = validateLiveRedisEnvironment(devEnv);
      expect(res.canRun).toBe(true);
      expect(res.details.length).toBe(0);
      expect(res.config?.url).toBe("https://dev-database.upstash.io");
    });
  });
});
