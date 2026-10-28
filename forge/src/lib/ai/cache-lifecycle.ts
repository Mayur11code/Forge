// src/lib/ai/cache-lifecycle.ts
//
// Lifecycle glue between source deletion and the semantic cache.
//
// Correctness never depends on this module: every cache hit is validated
// against the source set retrieved for the current request, so a deleted or
// edited source can never be served from a stale answer. This exists so that
// deleted content does not linger in the org's cache namespace until TTL.
//
// It is deliberately gated on `ENABLE_SEMANTIC_CACHE` (default "false") and
// imports the cache implementation lazily, so the deletion paths pay nothing
// while the feature is off and are never coupled to Redis/Pinecone at import
// time.

import { getAiEnv } from '@/lib/env/server';

export function isSemanticCacheEnabled(): boolean {
  try {
    return getAiEnv().ENABLE_SEMANTIC_CACHE === 'true';
  } catch {
    return false;
  }
}

/**
 * Best-effort org-cache invalidation after a committed deletion. Never throws,
 * never blocks deletion success, and never logs identifiers.
 */
export async function invalidateSemanticCacheBestEffort(
  orgId: string
): Promise<void> {
  if (typeof orgId !== 'string' || orgId.length === 0) return;
  if (!isSemanticCacheEnabled()) return;

  try {
    const { invalidateSemanticCacheForOrg } = await import('./semantic-cache');
    const result = await invalidateSemanticCacheForOrg(orgId);
    if (!result.pineconeCleared || !result.redisComplete) {
      console.warn(
        '[SEMANTIC_CACHE] event=cleanup_partial reason=lifecycle_invalidation'
      );
    }
  } catch {
    console.warn(
      '[SEMANTIC_CACHE] event=error reason=lifecycle_invalidation'
    );
  }
}
