import "server-only";
import { Redis } from '@upstash/redis';
import { getRedisEnv } from '@/lib/env/server';

// Ensure the standard singleton pattern for Next.js Hot Module Replacement
const redisClientSingleton = () => {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = getRedisEnv();
  return new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });
};

declare global {
  var redisGlobal: undefined | ReturnType<typeof redisClientSingleton>;
}

export const redis = globalThis.redisGlobal ?? redisClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  globalThis.redisGlobal = redis;
}
