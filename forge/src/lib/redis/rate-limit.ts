import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis/client";
import {
  checkRateLimit,
  RATE_LIMIT_POLICIES,
  RateLimitResult,
} from "@/lib/security/rate-limit";

/**
 * Backwards-compatible core limiter using the centralized Redis client.
 */
export const rateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
  analytics: false,
  prefix: "@forge/rl:req:task_create:v1:user",
});

/**
 * Evaluates the task creation rate limit using the centralized policy engine.
 */
export async function checkTaskCreateRateLimit(
  userId: string,
  orgId?: string
): Promise<RateLimitResult> {
  return await checkRateLimit({
    policy: RATE_LIMIT_POLICIES.REQUEST_TASK_CREATE,
    userId,
    orgId,
  });
}
