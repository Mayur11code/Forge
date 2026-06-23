import { redis } from '@/lib/redis/client';
import { getRawPineconeIndex } from '@/lib/vector/client'; 
import type {
  PineconeRecord as PineconeSdkRecord,
} from '@pinecone-database/pinecone';

import type { SemanticCacheMetadata } from '@/lib/vector/schema';

// 85% semantic similarity is the threshold for a "Cache Hit"
const CACHE_THRESHOLD = 0.85; 
// 7 days in seconds for the Redis TTL (Time To Live)
const CACHE_TTL = 60 * 60 * 24 * 7; 

export async function checkSemanticCache(queryEmbedding: number[], orgId: string) {
  // Use a dedicated cache namespace so we don't pollute your actual task documents
  const cacheNamespace = getRawPineconeIndex().namespace(`${orgId}-cache`);

  // 1. Search for highly similar past queries
  const cacheHits = await cacheNamespace.query({
    vector: queryEmbedding,
    topK: 1,
    includeMetadata: true,
  });

  const bestMatch = cacheHits.matches[0];

  // 2. Evaluate against our strict 0.85 threshold
  if (bestMatch && bestMatch.score && bestMatch.score >= CACHE_THRESHOLD) {
    const cacheKey = bestMatch.id;
    
    // 3. Fetch the heavy text payload from Upstash Redis
    const cachedResponse = await redis.get<string>(cacheKey);
    
    if (cachedResponse) {
      console.log(`⚡ [CACHE HIT] Latency bypassed. Score: ${bestMatch.score}`);
      return cachedResponse;
    }
  }
  console.log(`⚠️ [CACHE MISS] No suitable cached response found.${bestMatch ? ` Best score: ${bestMatch.score}` : ''}`);
  return null; // Cache Miss
}



const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const CACHE_VERSION = 'v1';

export async function setSemanticCache(queryEmbedding: number[], originalQuery: string, answer: string, orgId: string) {
  const cacheNamespace = getRawPineconeIndex().namespace(`${orgId}-cache`);
  // Generate a unique ID for this Q&A pair
  const cacheId = `cache:${orgId}:${Date.now()}`;

    const now = new Date();
  const expiresAt = new Date(
    now.getTime() + CACHE_TTL_SECONDS * 1000,
  ).toISOString();


  try {
    // 1. Save the heavy text answer to Upstash Redis with expiration
    await redis.set(cacheId, answer, { ex: CACHE_TTL });

// 2. Save the mathematical meaning of the question to Pinecone
const cacheRecord: PineconeSdkRecord<SemanticCacheMetadata> = {
  id: cacheId,
  values: queryEmbedding,
  metadata: {
    originalQuery,
    createdAt: now.toISOString(),
    expiresAt,
    type: 'cached_query',
    cacheVersion: CACHE_VERSION,
  },
};

await cacheNamespace.upsert({
  records: [cacheRecord],
});
    
    console.log(`💾 [CACHE WRITTEN] Saved new LLM response to semantic cache.`);
  } catch (error) {
    console.error("❌ Failed to write to semantic cache:", error);
  }
}