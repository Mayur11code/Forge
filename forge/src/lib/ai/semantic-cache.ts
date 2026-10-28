import crypto from 'crypto';
import type {
  Index,
  PineconeRecord as PineconeSdkRecord,
} from '@pinecone-database/pinecone';

import { db } from '@/lib/prisma/db';
import { redis } from '@/lib/redis/client';
import { getRawPineconeIndex } from '@/lib/vector/client';
import {
  resolveSourceProvenance,
  sourceSetsEqual,
  type SourceProvenance,
} from '@/lib/vector/provenance';
import {
  SEMANTIC_CACHE_VERSION,
  SemanticCacheMetadataSchema,
  SemanticCachePayloadSchema,
  type SemanticCacheMetadata,
  type SemanticCachePayload,
} from '@/lib/vector/schema';

import { digestQuery } from './cache-identity';

/**
 * 85% semantic similarity baseline threshold for a cache hit candidate.
 * NOTE: Uncalibrated baseline threshold retained from prototype; requires empirical calibration.
 */
const CACHE_THRESHOLD = 0.85;

/** 7 days in seconds for cache payload TTL in Redis */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Bounded candidate evaluation: never fan out over an unbounded match list. */
const MAX_CANDIDATES = 3;

const CACHE_VERSION = SEMANTIC_CACHE_VERSION;

/** Redis invalidation is bounded: 50 pages x 100 keys per call. */
const INVALIDATION_SCAN_PAGES = 50;
const INVALIDATION_SCAN_COUNT = 100;

/**
 * Opportunistic pruning of vectors whose payload TTL has already elapsed.
 * At most one range-delete per hour per server instance; the operation is
 * best-effort and must never delay or fail a chat request.
 */
const EXPIRY_PRUNE_COOLDOWN_MS = 60 * 60 * 1000;
let lastExpiryPruneAtMs = 0;

/** Test-only: makes pruning deterministic across cases. */
export function __resetSemanticCacheRuntimeForTests(): void {
  lastExpiryPruneAtMs = 0;
}

/**
 * Everything that must be identical for a semantically similar query to be
 * interchangeable with a stored answer.
 *
 * All fields are mandatory by design. An entry that cannot state its model,
 * embedding model, prompt version, or conversation history cannot be proven
 * answer-equivalent and must not be served.
 */
export interface SemanticCacheContext {
  orgId: string;
  userId: string;
  modelId: string;
  embeddingModelId: string;
  promptVersion: string;
  /**
   * Digest of the conversation *before* the current user turn. Answers may
   * depend on earlier turns even when the latest user message differs, so
   * prior history is part of cache identity rather than an implicit assumption.
   */
  historyFingerprint: string;
}

/** Write-side context additionally carries the verified retrieval provenance. */
export interface SemanticCacheWriteContext extends SemanticCacheContext {
  provenanceComplete: boolean;
  sources: SourceProvenance[];
}

export interface SemanticCacheInvalidationResult {
  pineconeCleared: boolean;
  redisKeysDeleted: number;
  /**
   * False when the bounded Redis scan did not reach cursor 0. Some payloads may
   * still exist; they remain protected by TTL and by the read-time membership
   * and source-provenance checks.
   */
  redisComplete: boolean;
}

type LogEvent =
  | 'hit'
  | 'miss'
  | 'rejected'
  | 'error'
  | 'write_skipped'
  | 'write_failed'
  | 'invalidated'
  | 'pruned'
  | 'cleanup_partial';

/**
 * Sanitized observability: event + short reason code only. Never logs the query,
 * the answer, source ids, or principal identifiers.
 */
function logCacheEvent(event: LogEvent, reason?: string): void {
  const line = `[SEMANTIC_CACHE] event=${event}${reason ? ` reason=${reason}` : ''}`;
  if (event === 'hit' || event === 'miss') {
    console.info(line);
  } else {
    console.warn(line);
  }
}

function isUsableEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 768 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function hasRequiredStrings(context: SemanticCacheContext): boolean {
  return (
    typeof context.orgId === 'string' &&
    context.orgId.length > 0 &&
    typeof context.userId === 'string' &&
    context.userId.length > 0 &&
    typeof context.modelId === 'string' &&
    context.modelId.length > 0 &&
    typeof context.embeddingModelId === 'string' &&
    context.embeddingModelId.length > 0 &&
    typeof context.promptVersion === 'string' &&
    context.promptVersion.length > 0 &&
    typeof context.historyFingerprint === 'string' &&
    context.historyFingerprint.length > 0
  );
}

/**
 * The source set observed by *this* request's retrieval. It must be complete
 * and non-empty; an empty set means retrieval produced nothing verifiable, and
 * no cached answer can be shown to still match it.
 */
function hasUsableCurrentSources(sources: unknown): sources is SourceProvenance[] {
  return (
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every(
      (source) =>
        source !== null &&
        typeof source === 'object' &&
        (source.type === 'task' || source.type === 'attachment') &&
        typeof source.id === 'string' &&
        source.id.length > 0 &&
        typeof source.version === 'string' &&
        source.version.length > 0
    )
  );
}

type SourceArrays = Pick<
  SemanticCacheMetadata,
  'sourceTypes' | 'sourceIds' | 'sourceVersions'
>;

function sourcesFromMetadata(metadata: SourceArrays): SourceProvenance[] {
  const types = metadata.sourceTypes ?? [];
  const ids = metadata.sourceIds ?? [];
  const versions = metadata.sourceVersions ?? [];

  return ids.map((id, index) => ({
    type: types[index],
    id,
    version: versions[index],
  }));
}

/**
 * Checks that the Redis payload describes the same entry as the Pinecone
 * metadata it was fetched for: same id, same principal, same compatibility
 * inputs, same provenance, same expiry, same stored query digest.
 */
function payloadMatchesMetadata(
  payload: SemanticCachePayload,
  metadata: SemanticCacheMetadata,
  cacheId: string
): boolean {
  if (payload.cacheId !== cacheId) return false;
  if (payload.orgId !== metadata.orgId) return false;
  if (payload.userId !== metadata.userId) return false;
  if (payload.cacheVersion !== metadata.cacheVersion) return false;
  if (payload.modelId !== metadata.modelId) return false;
  if (payload.embeddingModelId !== metadata.embeddingModelId) return false;
  if (payload.promptVersion !== metadata.promptVersion) return false;
  if (payload.historyFingerprint !== metadata.historyFingerprint) return false;
  if (payload.queryDigest !== metadata.queryDigest) return false;
  if (payload.createdAt !== metadata.createdAt) return false;
  if (payload.expiresAt !== metadata.expiresAt) return false;
  if (payload.expiresAtUnix !== metadata.expiresAtUnix) return false;
  if (!sourceSetsEqual(sourcesFromMetadata(payload), sourcesFromMetadata(metadata))) {
    return false;
  }
  return true;
}

/**
 * Deletes a single stale candidate vector. Best-effort: a failure only means
 * the stale vector lives until its namespace is swept, never a request error.
 */
async function deleteCandidateBestEffort(
  namespace: Index,
  cacheId: string,
  reason: string
): Promise<void> {
  try {
    await namespace.deleteMany({ ids: [cacheId] });
  } catch {
    logCacheEvent('error', `delete_${reason}`);
  }
}

/**
 * Opportunistically removes vectors whose payload has long expired, so stale
 * entries do not accumulate in Pinecone after the Redis TTL has passed.
 *
 * The filter form is type-checked against the SDK but its server-side
 * behaviour is not exercised by unit tests; any rejection is swallowed because
 * pruning is an optimization, not a correctness requirement.
 */
async function pruneExpiredCacheVectors(
  namespace: Index,
  nowMs: number
): Promise<void> {
  if (nowMs - lastExpiryPruneAtMs < EXPIRY_PRUNE_COOLDOWN_MS) return;
  lastExpiryPruneAtMs = nowMs;

  try {
    await namespace.deleteMany({
      filter: { expiresAtUnix: { $lt: Math.floor(nowMs / 1000) } },
    });
    logCacheEvent('pruned', 'expired_vectors');
  } catch {
    logCacheEvent('error', 'expiry_prune');
  }
}

/**
 * Checks the semantic cache for a reusable answer matching the given query embedding.
 *
 * Security & reliability invariants (all fail closed to a normal cache miss):
 * 1. Authorization is re-verified: the caller must still be a member of the org.
 * 2. Scope isolation: Pinecone metadata and Redis payload must match the
 *    authenticated principal and organization; the namespace is org-scoped too.
 * 3. Compatibility: cache version, language model, embedding model, prompt
 *    version and conversation-history fingerprint must all match.
 * 4. Source identity: the stored provenance must describe exactly the source
 *    set retrieved for *this* request, at exactly the same versions. Sources
 *    are resolved from the database by the caller's retrieval step, so this
 *    comparison is the authoritative freshness and authorization check.
 * 5. Strict schema validation: malformed, legacy, partial, or swapped entries
 *    are rejected rather than repaired.
 * 6. Fail-open on infrastructure errors: Pinecone/Redis/DB failures degrade to
 *    an uncached request, never to an error response.
 */
export async function checkSemanticCache(
  queryEmbedding: number[],
  context: SemanticCacheContext,
  currentSources: SourceProvenance[]
): Promise<string | null> {
  try {
    if (!isUsableEmbedding(queryEmbedding) || !hasRequiredStrings(context)) {
      logCacheEvent('miss', 'incomplete_context');
      return null;
    }

    // An answer with no verifiable current sources cannot be compared against
    // anything, so no stored answer is provably interchangeable with it.
    if (!hasUsableCurrentSources(currentSources)) {
      logCacheEvent('miss', 'no_current_sources');
      return null;
    }

    const {
      orgId,
      userId,
      modelId,
      embeddingModelId,
      promptVersion,
      historyFingerprint,
    } = context;

    // 1. Re-verify authorization at read time. Organization membership is the
    // app's authoritative grant for all resources in the org.
    const membership = await (db.membership.findFirst({
      where: { orgId, userId },
      select: { userId: true },
    }) as unknown as Promise<{ userId: string } | null>);

    if (!membership) {
      logCacheEvent('rejected', 'authorization');
      return null;
    }

    const cacheNamespace = getRawPineconeIndex().namespace(`${orgId}-cache`);

    const nowMs = Date.now();
    const nowUnix = Math.floor(nowMs / 1000);

    // Best-effort cleanup of vectors whose Redis payload has expired. Never
    // allowed to affect the lookup.
    await pruneExpiredCacheVectors(cacheNamespace, nowMs);

    // 2. Search for similar queries belonging exclusively to this user in this organization
    const cacheHits = await cacheNamespace.query({
      vector: queryEmbedding,
      topK: MAX_CANDIDATES,
      includeMetadata: true,
      filter: {
        userId: { $eq: userId },
        orgId: { $eq: orgId },
      },
    });

    if (!cacheHits.matches || cacheHits.matches.length === 0) {
      logCacheEvent('miss');
      return null;
    }

    // 3. Evaluate a bounded set of candidates
    for (const candidate of cacheHits.matches.slice(0, MAX_CANDIDATES)) {
      if (
        typeof candidate.score !== 'number' ||
        candidate.score < CACHE_THRESHOLD
      ) {
        continue;
      }

      // Metadata schema, compatibility and provenance must be complete.
      const metaParsed = SemanticCacheMetadataSchema.safeParse(
        candidate.metadata
      );
      if (!metaParsed.success) {
        logCacheEvent('rejected', 'metadata');
        continue;
      }
      const metadata = metaParsed.data;

      // Identity guard: candidate must match the authenticated principal
      if (metadata.orgId !== orgId || metadata.userId !== userId) {
        logCacheEvent('rejected', 'identity');
        continue;
      }

      // Cache contract version
      if (metadata.cacheVersion !== CACHE_VERSION) {
        logCacheEvent('rejected', 'version');
        continue;
      }

      // Answer-equivalence inputs
      if (
        metadata.modelId !== modelId ||
        metadata.embeddingModelId !== embeddingModelId ||
        metadata.promptVersion !== promptVersion ||
        metadata.historyFingerprint !== historyFingerprint
      ) {
        logCacheEvent('rejected', 'compatibility');
        continue;
      }

      // Expiry verification (Pinecone may outlive the Redis TTL)
      if (metadata.expiresAtUnix <= nowUnix) {
        logCacheEvent('rejected', 'expired');
        await deleteCandidateBestEffort(cacheNamespace, candidate.id, 'expired');
        continue;
      }

      const sourceTypes = metadata.sourceTypes ?? [];
      const sourceIds = metadata.sourceIds ?? [];
      const sourceVersions = metadata.sourceVersions ?? [];

      // A zero-source answer is never written, and cannot be validated.
      if (
        metadata.sourceCount === 0 ||
        sourceIds.length === 0 ||
        sourceTypes.length !== sourceIds.length ||
        sourceVersions.length !== sourceIds.length
      ) {
        logCacheEvent('rejected', 'provenance_incomplete');
        continue;
      }

      // 4. Source identity: the cached answer is reusable only while the exact
      // same sources, at the exact same versions, are still what retrieval
      // returns today. The caller resolved this set from the database on this
      // request, so it already reflects deletions, edits, and re-scoping.
      if (!sourceSetsEqual(sourcesFromMetadata(metadata), currentSources)) {
        logCacheEvent('rejected', 'source_set_mismatch');
        continue;
      }

      // 5. Fetch and validate the answer payload from Upstash Redis
      const rawPayload = await redis.get<unknown>(candidate.id);
      if (!rawPayload) {
        logCacheEvent('rejected', 'payload_missing');
        // The payload TTL has elapsed; the vector is now unreachable garbage.
        await deleteCandidateBestEffort(
          cacheNamespace,
          candidate.id,
          'payload_missing'
        );
        continue;
      }

      let parsedPayload: unknown = rawPayload;
      if (typeof rawPayload === 'string') {
        try {
          parsedPayload = JSON.parse(rawPayload);
        } catch {
          // Reject unparsed legacy strings rather than trusting them.
          logCacheEvent('rejected', 'payload_not_json');
          continue;
        }
      }

      const payloadResult = SemanticCachePayloadSchema.safeParse(parsedPayload);
      if (!payloadResult.success) {
        logCacheEvent('rejected', 'payload');
        continue;
      }

      const payload = payloadResult.data;
      if (!payloadMatchesMetadata(payload, metadata, candidate.id)) {
        logCacheEvent('rejected', 'metadata_payload_mismatch');
        continue;
      }

      if (payload.expiresAtUnix <= nowUnix) {
        logCacheEvent('rejected', 'expired');
        await deleteCandidateBestEffort(cacheNamespace, candidate.id, 'expired');
        continue;
      }

      // The entry is authorized, compatible, fresh, internally consistent and
      // built from the same current sources: safe to serve.
      logCacheEvent('hit');
      return payload.answer;
    }

    logCacheEvent('miss', 'no_valid_candidate');
    return null;
  } catch {
    // Never surface cache infrastructure failures to the request path.
    logCacheEvent('error', 'cache_check');
    return null;
  }
}

/**
 * Stores a verified Q&A pair in the semantic cache.
 *
 * Refuses to write unless the answer's provenance is complete, non-empty, and
 * re-verified against the database at write time. A response with no sources is
 * not cached: such an answer is most likely a "nothing found" result, which is
 * the worst possible thing to serve for a different query later.
 */
export async function setSemanticCache(
  queryEmbedding: number[],
  originalQuery: string,
  answer: string,
  context: SemanticCacheWriteContext
): Promise<void> {
  try {
    if (
      !isUsableEmbedding(queryEmbedding) ||
      !hasRequiredStrings(context) ||
      typeof originalQuery !== 'string' ||
      originalQuery.trim().length === 0 ||
      typeof answer !== 'string' ||
      answer.trim().length === 0
    ) {
      logCacheEvent('write_skipped', 'invalid_input');
      return;
    }

    if (
      !context.provenanceComplete ||
      !hasUsableCurrentSources(context.sources)
    ) {
      logCacheEvent('write_skipped', 'provenance');
      return;
    }

    const {
      orgId,
      userId,
      modelId,
      embeddingModelId,
      promptVersion,
      historyFingerprint,
    } = context;

    // Re-verify provenance at write time so a version observed during retrieval
    // cannot be persisted after the underlying record changed in between.
    const verified = await resolveSourceProvenance(
      orgId,
      context.sources.map(({ type, id }) => ({ type, id }))
    );

    if (
      !verified.complete ||
      !sourceSetsEqual(verified.sources, context.sources)
    ) {
      logCacheEvent('write_skipped', 'source_changed');
      return;
    }

    const cacheNamespace = getRawPineconeIndex().namespace(`${orgId}-cache`);
    const cacheId = `cache:${orgId}:${userId}:${Date.now()}_${crypto
      .randomUUID()
      .slice(0, 8)}`;

    const nowMs = Date.now();
    const now = new Date(nowMs);
    const expiresMs = nowMs + CACHE_TTL_SECONDS * 1000;
    const createdAt = now.toISOString();
    const expiresAt = new Date(expiresMs).toISOString();
    const expiresAtUnix = Math.floor(expiresMs / 1000);

    const sourceTypes = verified.sources.map((source) => source.type);
    const sourceIds = verified.sources.map((source) => source.id);
    const sourceVersions = verified.sources.map((source) => source.version);
    const sourceCount = verified.sources.length;
    const queryDigest = digestQuery(originalQuery);

    const payload: SemanticCachePayload = {
      cacheId,
      answer,
      answerType: 'text',
      cacheVersion: CACHE_VERSION,
      orgId,
      userId,
      modelId,
      embeddingModelId,
      promptVersion,
      historyFingerprint,
      provenanceComplete: true,
      sourceCount,
      sourceTypes,
      sourceIds,
      sourceVersions,
      queryDigest,
      createdAt,
      expiresAt,
      expiresAtUnix,
    };

    // 1. Save structured payload to Upstash Redis with expiration
    await redis.set(cacheId, JSON.stringify(payload), { ex: CACHE_TTL_SECONDS });

    // 2. Save query vector to Pinecone with principal metadata
    const cacheRecord: PineconeSdkRecord<SemanticCacheMetadata> = {
      id: cacheId,
      values: queryEmbedding,
      metadata: {
        type: 'cached_query',
        cacheVersion: CACHE_VERSION,
        orgId,
        userId,
        modelId,
        embeddingModelId,
        promptVersion,
        historyFingerprint,
        provenanceComplete: true,
        sourceCount,
        sourceTypes,
        sourceIds,
        sourceVersions,
        queryDigest,
        createdAt,
        expiresAt,
        expiresAtUnix,
      },
    };

    await cacheNamespace.upsert({
      records: [cacheRecord],
    });
  } catch {
    logCacheEvent('write_failed');
  }
}

/**
 * Clears the semantic cache for an organization: the dedicated
 * `${orgId}-cache` namespace in Pinecone and the Redis payloads stored under
 * the org's cache key prefix.
 *
 * The key structure is `cache:${orgId}:${userId}:...`, so the prefix scan is
 * anchored on the trailing colon and cannot match a different organization's
 * keys. Redis cleanup is bounded (max 50 pages of 100 keys) to avoid unbounded
 * work inside a single call; when the bound is hit the result reports
 * `redisComplete: false` instead of pretending the namespace is empty.
 *
 * NOTE: no organization-deletion path currently exists in this codebase (only
 * organization *credential* deletion, which does not remove organization data).
 * The deletion worker calls this after a successful task/project/attachment
 * cleanup; residual entries are also unreachable for a deleted org (no session
 * can satisfy the membership check) and both vectors and payloads expire by TTL.
 */
export async function invalidateSemanticCacheForOrg(
  orgId: string
): Promise<SemanticCacheInvalidationResult> {
  const result: SemanticCacheInvalidationResult = {
    pineconeCleared: false,
    redisKeysDeleted: 0,
    redisComplete: false,
  };

  if (!orgId) return result;

  try {
    const primaryIndex = getRawPineconeIndex();
    await primaryIndex.namespace(`${orgId}-cache`).deleteAll();
    result.pineconeCleared = true;
    logCacheEvent('invalidated', 'pinecone');
  } catch {
    logCacheEvent('error', 'invalidation_pinecone');
  }

  try {
    const match = `cache:${orgId}:*`;
    let cursor: string | number = 0;
    for (let page = 0; page < INVALIDATION_SCAN_PAGES; page += 1) {
      const [nextCursor, keys] = (await redis.scan(cursor, {
        match,
        count: INVALIDATION_SCAN_COUNT,
      })) as [string, string[]];

      if (keys.length > 0) {
        await redis.del(...keys);
        result.redisKeysDeleted += keys.length;
      }

      cursor = nextCursor;
      if (String(cursor) === '0') {
        result.redisComplete = true;
        break;
      }
    }

    if (result.redisComplete) {
      logCacheEvent('invalidated', 'redis');
    } else {
      logCacheEvent('cleanup_partial', 'redis_page_bound');
    }
  } catch {
    logCacheEvent('error', 'invalidation_redis');
  }

  return result;
}
