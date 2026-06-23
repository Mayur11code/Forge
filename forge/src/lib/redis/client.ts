import { Redis } from '@upstash/redis';

// Ensure the standard singleton pattern for Next.js Hot Module Replacement
const redisClientSingleton = () => {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
};

declare global {
  var redisGlobal: undefined | ReturnType<typeof redisClientSingleton>;
}

export const redis = globalThis.redisGlobal ?? redisClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  globalThis.redisGlobal = redis;
}