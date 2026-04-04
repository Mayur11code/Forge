import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Initialize Redis from env
const redis = Redis.fromEnv();

// Core limiter (for logged-in actions)
export const rateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "10 s"),
  analytics: true,
  prefix: "@forge/core", // helps debugging in Upstash
});