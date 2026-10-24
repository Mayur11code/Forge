import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { type Redis } from "@upstash/redis";
import { redis as defaultRedis } from "@/lib/redis/client";
import { createHash } from "crypto";

export type RateLimitAlgorithm = "sliding_window" | "token_bucket";
export type RateLimitCategory = "ai_admission" | "request_sliding_window";

/**
 * Configuration specification for a rate limiting or AI admission policy.
 */
export interface RateLimitPolicyConfig {
  name: string;
  category: RateLimitCategory;
  algorithm: RateLimitAlgorithm;
  prefix: string;
  failClosed: boolean;
  timeoutMs?: number;
  userLimit?: {
    limit: number;
    windowOrInterval: `${number} ${"ms" | "s" | "m" | "h" | "d"}`;
    refillRate?: number;
  };
  orgLimit?: {
    limit: number;
    windowOrInterval: `${number} ${"ms" | "s" | "m" | "h" | "d"}`;
    refillRate?: number;
  };
  ipLimit?: {
    limit: number;
    windowOrInterval: `${number} ${"ms" | "s" | "m" | "h" | "d"}`;
  };
}

/**
 * Result returned by rate limit evaluation.
 */
export interface RateLimitResult {
  allowed: boolean;
  status: 200 | 429 | 503;
  error?: "RATE_LIMITED" | "RATE_LIMITER_UNAVAILABLE";
  message?: string;
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSeconds?: number;
  headers: Record<string, string>;
  warning?: string;
}

/**
 * Status snapshot returned by non-mutating getRemainingStatus query.
 */
export interface RateLimitStatus {
  available: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSeconds?: number;
}

/**
 * Authoritative Centralized Rate-Limiting & AI Admission Policies.
 */
export const RATE_LIMIT_POLICIES = {
  /**
   * Expensive autonomous agent session creation (starts background loop, tools, QStash).
   * Token bucket admission budget allows controlled bursts while bounding sustained execution.
   */
  AI_ADMISSION_AGENT_INIT: {
    name: "AI_ADMISSION_AGENT_INIT",
    category: "ai_admission",
    algorithm: "token_bucket",
    prefix: "@forge/rl:ai:agent_init:v1",
    failClosed: true,
    timeoutMs: 3000,
    userLimit: {
      limit: 5,
      windowOrInterval: "2 m",
      refillRate: 1,
    },
    orgLimit: {
      limit: 15,
      windowOrInterval: "1 m",
      refillRate: 2,
    },
  } as RateLimitPolicyConfig,

  /**
   * Interactive RAG chat stream (embedding generation, Pinecone retrieval, Gemini 3.6 flash stream).
   */
  AI_ADMISSION_CHAT: {
    name: "AI_ADMISSION_CHAT",
    category: "ai_admission",
    algorithm: "token_bucket",
    prefix: "@forge/rl:ai:chat:v1",
    failClosed: true,
    timeoutMs: 3000,
    userLimit: {
      limit: 10,
      windowOrInterval: "1 m",
      refillRate: 3,
    },
    orgLimit: {
      limit: 30,
      windowOrInterval: "1 m",
      refillRate: 6,
    },
  } as RateLimitPolicyConfig,

  /**
   * Automated bug triage using Gemini structured object output.
   */
  AI_ADMISSION_TRIAGE: {
    name: "AI_ADMISSION_TRIAGE",
    category: "ai_admission",
    algorithm: "token_bucket",
    prefix: "@forge/rl:ai:triage:v1",
    failClosed: true,
    timeoutMs: 3000,
    userLimit: {
      limit: 10,
      windowOrInterval: "1 m",
      refillRate: 2,
    },
  } as RateLimitPolicyConfig,

  /**
   * User task creation within organization projects (sliding window).
   */
  REQUEST_TASK_CREATE: {
    name: "REQUEST_TASK_CREATE",
    category: "request_sliding_window",
    algorithm: "sliding_window",
    prefix: "@forge/rl:req:task_create:v1",
    failClosed: false,
    timeoutMs: 2000,
    userLimit: {
      limit: 10,
      windowOrInterval: "10 s",
    },
    orgLimit: {
      limit: 100,
      windowOrInterval: "1 m",
    },
  } as RateLimitPolicyConfig,

  /**
   * Interactive agent step confirmations / clarifications / proposal review actions.
   */
  REQUEST_AGENT_ACTION: {
    name: "REQUEST_AGENT_ACTION",
    category: "request_sliding_window",
    algorithm: "sliding_window",
    prefix: "@forge/rl:req:agent_action:v1",
    failClosed: false,
    timeoutMs: 2000,
    userLimit: {
      limit: 20,
      windowOrInterval: "1 m",
    },
  } as RateLimitPolicyConfig,

  /**
   * Workflow canvas test run execution.
   */
  REQUEST_WORKFLOW_TEST_RUN: {
    name: "REQUEST_WORKFLOW_TEST_RUN",
    category: "request_sliding_window",
    algorithm: "sliding_window",
    prefix: "@forge/rl:req:wf_test_run:v1",
    failClosed: true,
    timeoutMs: 2500,
    userLimit: {
      limit: 5,
      windowOrInterval: "1 m",
    },
  } as RateLimitPolicyConfig,

  /**
   * Coarse public IP protection for unauthenticated endpoints.
   */
  UNAUTHENTICATED_PUBLIC_IP: {
    name: "UNAUTHENTICATED_PUBLIC_IP",
    category: "request_sliding_window",
    algorithm: "sliding_window",
    prefix: "@forge/rl:req:public_ip:v1",
    failClosed: false,
    timeoutMs: 2000,
    ipLimit: {
      limit: 30,
      windowOrInterval: "1 m",
    },
  } as RateLimitPolicyConfig,
};

/**
 * Builds standard compliant rate limit HTTP headers.
 */
export function buildRateLimitHeaders(
  limit: number,
  remaining: number,
  resetMs: number,
  retryAfterSeconds?: number
): Record<string, string> {
  const retryAfter =
    retryAfterSeconds !== undefined
      ? retryAfterSeconds
      : Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));

  return {
    "Retry-After": String(retryAfter),
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Reset": String(resetMs),
  };
}

/**
 * Generates privacy-safe, non-PII Redis identifier keys.
 */
export function formatRateLimitIdentifier(
  scope: "u" | "o" | "ip",
  rawId: string
): string {
  if (scope === "ip") {
    // Hashing prevents raw IP addresses in Redis keys and audit logs
    const hash = createHash("sha256").update(rawId).digest("hex").slice(0, 16);
    return `ip:${hash}`;
  }
  // Sanitize user or organization ID
  const sanitized = rawId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `${scope}:${sanitized}`;
}

/**
 * Creates or retrieves a memoized Upstash Ratelimit instance for a policy and scope.
 */
const limiterRegistry = new Map<string, Ratelimit>();

export function getOrCreateRatelimit(
  policy: RateLimitPolicyConfig,
  scope: "user" | "org" | "ip",
  redisClient?: Redis
): Ratelimit {
  const targetRedis = redisClient ?? defaultRedis;
  const registryKey = `${policy.prefix}:${scope}`;

  if (!redisClient && limiterRegistry.has(registryKey)) {
    return limiterRegistry.get(registryKey)!;
  }

  let limiterImpl: ReturnType<typeof Ratelimit.slidingWindow> | ReturnType<typeof Ratelimit.tokenBucket>;

  if (scope === "user" && policy.userLimit) {
    if (policy.algorithm === "token_bucket" && policy.userLimit.refillRate) {
      limiterImpl = Ratelimit.tokenBucket(
        policy.userLimit.refillRate,
        policy.userLimit.windowOrInterval,
        policy.userLimit.limit
      );
    } else {
      limiterImpl = Ratelimit.slidingWindow(
        policy.userLimit.limit,
        policy.userLimit.windowOrInterval
      );
    }
  } else if (scope === "org" && policy.orgLimit) {
    if (policy.algorithm === "token_bucket" && policy.orgLimit.refillRate) {
      limiterImpl = Ratelimit.tokenBucket(
        policy.orgLimit.refillRate,
        policy.orgLimit.windowOrInterval,
        policy.orgLimit.limit
      );
    } else {
      limiterImpl = Ratelimit.slidingWindow(
        policy.orgLimit.limit,
        policy.orgLimit.windowOrInterval
      );
    }
  } else if (scope === "ip" && policy.ipLimit) {
    limiterImpl = Ratelimit.slidingWindow(
      policy.ipLimit.limit,
      policy.ipLimit.windowOrInterval
    );
  } else {
    throw new Error(
      `[RATE_LIMIT] Policy ${policy.name} is missing configuration for scope ${scope}`
    );
  }

  const instance = new Ratelimit({
    redis: targetRedis,
    limiter: limiterImpl,
    prefix: `${policy.prefix}:${scope}`,
    timeout: policy.timeoutMs ?? 2500,
    analytics: false,
  });

  if (!redisClient) {
    limiterRegistry.set(registryKey, instance);
  }

  return instance;
}

export interface CheckRateLimitOptions {
  policy: RateLimitPolicyConfig;
  userId?: string;
  orgId?: string;
  ip?: string;
  redis?: Redis;
}

/**
 * Evaluates rate limiting for an incoming request against user and organization limits.
 *
 * Consumption semantics:
 * Sequential multi-limiter evaluation: When both userId and orgId are supplied, the user
 * limiter is evaluated first. If user limit succeeds but organization limit rejects,
 * the user token/request was already consumed. This sequential behavior is explicit.
 */
export async function checkRateLimit(
  options: CheckRateLimitOptions
): Promise<RateLimitResult> {
  const { policy, userId, orgId, ip, redis: customRedis } = options;

  // 1. Unauthenticated IP Limit
  if (ip && !userId && policy.ipLimit) {
    const ipIdentifier = formatRateLimitIdentifier("ip", ip);
    const ipLimiter = getOrCreateRatelimit(policy, "ip", customRedis);
    return await executeLimiterCheck(ipLimiter, ipIdentifier, policy);
  }

  // 2. User-level Limit
  if (userId && policy.userLimit) {
    const userIdentifier = formatRateLimitIdentifier("u", userId);
    const userLimiter = getOrCreateRatelimit(policy, "user", customRedis);
    const userResult = await executeLimiterCheck(userLimiter, userIdentifier, policy);

    if (!userResult.allowed) {
      return userResult;
    }

    // 3. Organization-level Limit (evaluated after user check)
    if (orgId && policy.orgLimit) {
      const orgIdentifier = formatRateLimitIdentifier("o", orgId);
      const orgLimiter = getOrCreateRatelimit(policy, "org", customRedis);
      const orgResult = await executeLimiterCheck(orgLimiter, orgIdentifier, policy);

      if (!orgResult.allowed) {
        return orgResult;
      }

      // Return the more restrictive remaining count
      return {
        allowed: true,
        status: 200,
        limit: Math.min(userResult.limit, orgResult.limit),
        remaining: Math.min(userResult.remaining, orgResult.remaining),
        reset: Math.max(userResult.reset, orgResult.reset),
        headers: buildRateLimitHeaders(
          Math.min(userResult.limit, orgResult.limit),
          Math.min(userResult.remaining, orgResult.remaining),
          Math.max(userResult.reset, orgResult.reset)
        ),
      };
    }

    return userResult;
  }

  // 4. Fallback if only orgId was provided
  if (orgId && policy.orgLimit) {
    const orgIdentifier = formatRateLimitIdentifier("o", orgId);
    const orgLimiter = getOrCreateRatelimit(policy, "org", customRedis);
    return await executeLimiterCheck(orgLimiter, orgIdentifier, policy);
  }

  // No applicable limit scope found
  return {
    allowed: true,
    status: 200,
    limit: 0,
    remaining: 0,
    reset: 0,
    headers: {},
  };
}

/**
 * Internal execution wrapper with timeout and failure-mode handling.
 */
async function executeLimiterCheck(
  limiter: Ratelimit,
  identifier: string,
  policy: RateLimitPolicyConfig
): Promise<RateLimitResult> {
  try {
    const result = await limiter.limit(identifier);

    // CRITICAL: Upstash Ratelimit's applyTimeout resolves { success: true, reason: "timeout" }.
    // When timeout occurs, Redis enforcement was NOT verified.
    if ((result as { reason?: string }).reason === "timeout") {
      if (policy.failClosed) {
        console.warn(
          `[RATE_LIMIT] Timeout on limiter for policy ${policy.name} (failing closed)`
        );
        return {
          allowed: false,
          status: 503,
          error: "RATE_LIMITER_UNAVAILABLE",
          message:
            "Rate limit verification temporarily unavailable. Please try again shortly.",
          limit: 0,
          remaining: 0,
          reset: Date.now() + 5000,
          retryAfterSeconds: 5,
          headers: {
            "Retry-After": "5",
          },
        };
      } else {
        console.warn(
          `[RATE_LIMIT] Timeout on limiter for policy ${policy.name} (failing open)`
        );
        return {
          allowed: true,
          status: 200,
          limit: 0,
          remaining: 0,
          reset: 0,
          headers: {},
          warning: "RATE_LIMITER_TIMEOUT_FAIL_OPEN",
        };
      }
    }

    if (!result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.reset - Date.now()) / 1000)
      );

      return {
        allowed: false,
        status: 429,
        error: "RATE_LIMITED",
        message:
          policy.category === "ai_admission"
            ? "AI admission rate limit reached. Please wait before starting another session."
            : "Too many requests. Please wait before retrying.",
        limit: result.limit,
        remaining: Math.max(0, result.remaining),
        reset: result.reset,
        retryAfterSeconds: retryAfter,
        headers: buildRateLimitHeaders(
          result.limit,
          result.remaining,
          result.reset,
          retryAfter
        ),
      };
    }

    return {
      allowed: true,
      status: 200,
      limit: result.limit,
      remaining: Math.max(0, result.remaining),
      reset: result.reset,
      headers: buildRateLimitHeaders(
        result.limit,
        result.remaining,
        result.reset
      ),
    };
  } catch (error) {
    if (policy.failClosed) {
      console.error(
        `[RATE_LIMIT] Redis failure enforcing ${policy.name} (failing closed):`,
        error instanceof Error ? error.message : String(error)
      );
      return {
        allowed: false,
        status: 503,
        error: "RATE_LIMITER_UNAVAILABLE",
        message:
          "Rate limit verification temporarily unavailable. Please try again shortly.",
        limit: 0,
        remaining: 0,
        reset: Date.now() + 5000,
        retryAfterSeconds: 5,
        headers: {
          "Retry-After": "5",
        },
      };
    } else {
      console.warn(
        `[RATE_LIMIT] Redis failure enforcing ${policy.name} (failing open):`,
        error instanceof Error ? error.message : String(error)
      );
      return {
        allowed: true,
        status: 200,
        limit: 0,
        remaining: 0,
        reset: 0,
        headers: {},
        warning: "RATE_LIMITER_EXCEPTION_FAIL_OPEN",
      };
    }
  }
}

/**
 * Non-mutating read of remaining quota using Upstash getRemaining().
 * NEVER consumes tokens or counts against limits.
 */
export async function getRateLimitStatus(options: {
  policy: RateLimitPolicyConfig;
  userId?: string;
  orgId?: string;
  redis?: Redis;
}): Promise<RateLimitStatus> {
  const { policy, userId, orgId, redis: customRedis } = options;

  try {
    if (userId && policy.userLimit) {
      const userIdentifier = formatRateLimitIdentifier("u", userId);
      const userLimiter = getOrCreateRatelimit(policy, "user", customRedis);
      const status = await userLimiter.getRemaining(userIdentifier);
      const retryAfter =
        status.remaining <= 0
          ? Math.max(1, Math.ceil((status.reset - Date.now()) / 1000))
          : undefined;

      return {
        available: true,
        limit: status.limit,
        remaining: status.remaining,
        reset: status.reset,
        retryAfterSeconds: retryAfter,
      };
    }

    if (orgId && policy.orgLimit) {
      const orgIdentifier = formatRateLimitIdentifier("o", orgId);
      const orgLimiter = getOrCreateRatelimit(policy, "org", customRedis);
      const status = await orgLimiter.getRemaining(orgIdentifier);
      const retryAfter =
        status.remaining <= 0
          ? Math.max(1, Math.ceil((status.reset - Date.now()) / 1000))
          : undefined;

      return {
        available: true,
        limit: status.limit,
        remaining: status.remaining,
        reset: status.reset,
        retryAfterSeconds: retryAfter,
      };
    }

    return {
      available: false,
      limit: 0,
      remaining: 0,
      reset: 0,
    };
  } catch (error) {
    console.warn(
      `[RATE_LIMIT] Failed to query rate limit status for ${policy.name}:`,
      error instanceof Error ? error.message : String(error)
    );
    return {
      available: false,
      limit: 0,
      remaining: 0,
      reset: 0,
    };
  }
}

/**
 * Constructs a safe Next.js Response object for rate limit rejection.
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    {
      error: result.error,
      message: result.message,
      retryAfter: result.retryAfterSeconds,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    },
    {
      status: result.status,
      headers: result.headers,
    }
  );
}

/**
 * Extracts client IP from request headers on Vercel / trusted proxies.
 * Note: Browser-supplied X-Forwarded-For can be spoofed in untrusted environments;
 * in local development or custom reverse proxies, this is best-effort.
 */
export function getClientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-vercel-forwarded-for") || req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return null;
}
