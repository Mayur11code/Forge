
import { z } from 'zod';

const BaseVectorMetadataSchema = z.object({
  // The actual semantic chunk representation
  text: z.string().min(1, "Text chunk cannot be empty"),
  
  // Logical partitioning (Namespaces handle strict isolation, 
  // but we retain these for granular, intra-namespace filtering)
  orgId: z.string().min(1), 
  projectId: z.string().min(1),
  
  // Categorical identification
  type: z.enum(['task', 'note', 'document', 'comment']),
  
  // Optional relations (Must remain flat strings, NEVER nested objects)
  taskId: z.string().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),

  // Authoritative versioning for data freshness
  sourceVersion: z.string().min(1).optional(),
  parentTaskVersion: z.string().min(1).optional(),
});

export const VectorMetadataSchema = BaseVectorMetadataSchema
// THE SANITIZER: Pinecone crashes on null/undefined. 
// This transformation scrubs the object before it hits the network.
.transform((data) => {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value != null)
  );
});

export const PineconeRecordSchema = z.object({
  id: z.string().min(1, "Record ID is required"), // Must map exactly to the Prisma Primary Key
  values: z.array(z.number()).length(768, "Embedding must be exactly 768 dimensions"), 
  metadata: VectorMetadataSchema
});

// Single Source of Truth for TypeScript Types
export type VectorMetadata = z.input<typeof BaseVectorMetadataSchema>;
export type PineconeRecord = z.infer<typeof PineconeRecordSchema>;


/**
 * Semantic cache contract version. Bumped whenever the record shape, the
 * compatibility fields, or the provenance/freshness rules change. Entries
 * written under another version are rejected, never migrated in place:
 * older entries carry no source versions, no history fingerprint, and no
 * machine-checkable expiry, so they cannot be proven safe to reuse.
 */
export const SEMANTIC_CACHE_VERSION = 'v3' as const;

/** Source kinds the retrieval pipeline can actually return. */
export const SemanticSourceTypeSchema = z.enum(['task', 'attachment']);
export type SemanticSourceType = z.infer<typeof SemanticSourceTypeSchema>;

/**
 * Fields shared by the Pinecone metadata and the Redis payload.
 *
 * Both must describe the SAME cache entry, so they are defined once here and
 * validated with the same rules on the way out and on the way back in.
 *
 * Every field is mandatory. `modelId`, `embeddingModelId`, `promptVersion` and
 * `historyFingerprint` decide whether a semantically similar query is actually
 * interchangeable with this answer, so an entry that cannot state them cannot
 * be proven safe and is rejected. `provenanceComplete` is a literal `true`
 * because an incomplete entry must never have been written.
 */
const semanticCacheSharedShape = {
  cacheVersion: z.string().min(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  modelId: z.string().min(1),
  embeddingModelId: z.string().min(1),
  promptVersion: z.string().min(1),
  historyFingerprint: z.string().min(1),
  provenanceComplete: z.literal(true),
  // Provenance is stored as parallel flat arrays because Pinecone metadata
  // cannot hold nested objects. `sourceCount` is the authority; the arrays are
  // optional only so an entry with zero sources is representable at all (it is
  // never written by this implementation).
  sourceCount: z.number().int().min(0),
  sourceTypes: z.array(SemanticSourceTypeSchema).optional(),
  sourceIds: z.array(z.string().min(1)).optional(),
  sourceVersions: z.array(z.string().min(1)).optional(),
  /**
   * Digest of the canonicalized stored query. The query text itself is not
   * persisted (it can contain customer data), and the digest is never used as
   * a hit condition â€” only to prove that metadata and payload describe the
   * same entry.
   */
  queryDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'queryDigest must be a lowercase sha256 hex digest'),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  /**
   * Machine-friendly expiry used for range filtering when pruning stale cache
   * vectors. Must agree exactly with `expiresAt`; a divergence is corruption.
   */
  expiresAtUnix: z.number().int().nonnegative(),
};

/**
 * Rejects a shared entry that is internally inconsistent:
 * - `sourceCount` must equal the three parallel array lengths. A record that
 *   says "one source" while storing none is exactly the partial provenance
 *   that must not be trusted.
 * - `expiresAtUnix` must be the epoch-second form of `expiresAt`, so the
 *   numeric field cannot be used to smuggle a different lifetime.
 */
function refineSharedEntry(
  value: {
    sourceCount: number;
    sourceTypes?: string[];
    sourceIds?: string[];
    sourceVersions?: string[];
    expiresAt: string;
    expiresAtUnix: number;
  },
  ctx: z.RefinementCtx
) {
  const types = value.sourceTypes ?? [];
  const ids = value.sourceIds ?? [];
  const versions = value.sourceVersions ?? [];

  if (
    value.sourceCount !== types.length ||
    types.length !== ids.length ||
    ids.length !== versions.length
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Source provenance is incomplete: sourceCount, sourceTypes, sourceIds and sourceVersions must agree.',
      path: ['sourceCount'],
    });
  }

  const expectedUnix = Math.floor(Date.parse(value.expiresAt) / 1000);
  if (value.expiresAtUnix !== expectedUnix) {
    ctx.addIssue({
      code: 'custom',
      message: 'expiresAtUnix must equal the epoch seconds of expiresAt.',
      path: ['expiresAtUnix'],
    });
  }
}

export const SemanticCacheMetadataSchema = z
  .object({
    type: z.literal('cached_query'),
    ...semanticCacheSharedShape,
  })
  .strict()
  .superRefine(refineSharedEntry);

export const SemanticCacheRecordSchema = z.object({
  id: z.string().min(1),
  values: z.array(z.number()).length(768),
  metadata: SemanticCacheMetadataSchema,
});

/**
 * Redis payload. `cacheId` must equal the Pinecone record id it is stored
 * under, so a mis-keyed or swapped payload is detected instead of trusted.
 * `answerType` pins the payload to the only response form this cache stores.
 */
export const SemanticCachePayloadSchema = z
  .object({
    cacheId: z.string().min(1),
    answer: z.string().min(1),
    answerType: z.literal('text'),
    ...semanticCacheSharedShape,
  })
  .strict()
  .superRefine(refineSharedEntry);

export type SemanticCacheMetadata = z.infer<
  typeof SemanticCacheMetadataSchema
>;

export type SemanticCacheRecord = z.infer<
  typeof SemanticCacheRecordSchema
>;

export type SemanticCachePayload = z.infer<
  typeof SemanticCachePayloadSchema
>;
