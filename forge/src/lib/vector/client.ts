import "server-only";
// src/lib/vector/client.ts
import { Pinecone, type RecordMetadata, type PineconeRecord } from '@pinecone-database/pinecone';
import {
  VectorMetadata,
  PineconeRecordSchema,
  PineconeRecordV2,
  PineconeRecordV2Schema,
  buildVectorId,
  parseVectorId,
  computeManifestDigest,
} from './schema';
import { getVectorEnv } from '@/lib/env/server';
import {
  isPineconeAuthenticationError,
  logCredentialFailover,
} from '@/lib/security/credential-rotation';

// 1. Environment and Profile Check via Centralized Zod Validation
const { apiKey, fallbackApiKey, indexName } = getVectorEnv();

// 2. The Singleton Instantiator
const pineconeClientSingleton = () => {
  return new Pinecone({ apiKey });
};

// Prevent TypeScript from throwing errors on global property access
declare global {
  var pineconeGlobal: undefined | ReturnType<typeof pineconeClientSingleton>;
  var pineconeFallbackGlobal: undefined | ReturnType<typeof pineconeClientSingleton>;
}

// In development, persist the client across hot-reloads via globalThis
const pinecone = globalThis.pineconeGlobal ?? pineconeClientSingleton();
const pineconeFallback = fallbackApiKey
  ? (globalThis.pineconeFallbackGlobal ?? new Pinecone({ apiKey: fallbackApiKey }))
  : null;

if (process.env.NODE_ENV !== 'production') {
  globalThis.pineconeGlobal = pinecone;
  if (pineconeFallback) {
    globalThis.pineconeFallbackGlobal = pineconeFallback;
  }
}

// 3. Export the Strongly-Typed Raw Index
// By passing the Generic <T>, the Pinecone SDK automatically provides
// type checking and autocomplete for our specific metadata fields on queries.
export const getRawPineconeIndex = <T extends RecordMetadata = RecordMetadata>() => pinecone.index<T>(indexName);




export function getTenantVectorStore(orgId: string) {
  if (!orgId) {
    throw new Error("CRITICAL: orgId is required to instantiate the tenant vector store.");
  }

  const primaryIndex = getRawPineconeIndex();
  const primaryNamespace = primaryIndex.namespace(orgId);

  const fallbackNamespace = pineconeFallback
    ? pineconeFallback.index<VectorMetadata>(indexName).namespace(orgId)
    : null;

  async function executeWithFailover<T>(
    operation: string,
    action: (ns: typeof primaryNamespace) => Promise<T>
  ): Promise<T> {
    try {
      return await action(primaryNamespace);
    } catch (err) {
      if (fallbackNamespace && isPineconeAuthenticationError(err)) {
        logCredentialFailover({
          provider: "pinecone",
          subsystem: "vector",
          slot: "primary",
          operation,
          errorCategory: "AUTH_FAILURE_FAILOVER",
          message: err instanceof Error ? err.message : String(err),
        });
        return await action(fallbackNamespace);
      }
      throw err;
    }
  }

  return {
    async query(vector: number[], topK: number = 5, filter?: Partial<VectorMetadata>) {
      // The filter parameter is strictly typed by Partial<VectorMetadata>.
      // We do NOT use the filter for orgId isolation—the namespace handles that natively.
      // This filter is reserved strictly for logical queries (e.g., status === 'TODO').
      return executeWithFailover("query", (ns) =>
        ns.query({
          vector,
          topK,
          includeMetadata: true,
          filter,
        })
      );
    },

    async upsert(id: string, vector: number[], metadata: Omit<VectorMetadata, 'orgId'>) {
      // 2. Re-inject the orgId at the system level so the developer doesn't have to manually pass it
      const rawPayload = {
        id,
        values: vector,
        metadata: { ...metadata, orgId }
      };

      // 3. The Guardrail execution: Scrub nulls, validate dimensions, and verify Enums
      const safeRecord = PineconeRecordSchema.parse(rawPayload);

      // 4. Upsert strictly into the locked namespace with auth failover
      return executeWithFailover("upsert", (ns) =>
        ns.upsert({ records: [safeRecord] })
      );
    },

    async deleteRecord(id: string) {
      return executeWithFailover("deleteRecord", (ns) => ns.deleteOne({ id }));
    },

    // Replace the existing deleteByTask method in src/lib/vector/client.ts
    async deleteByTask(taskId: string) {
      if (!taskId) throw new Error("taskId is required for a wipe operation.");

      // Pinecone Serverless in certain regions throws a 404 for metadata deletions.
      // Because we used Deterministic Suffixing (e.g., task_123#0, task_123#1),
      // we can completely bypass the bug by fetching IDs by prefix and deleting them explicitly.
      return executeWithFailover("deleteByTask", async (ns) => {
        const chunkIds: string[] = [];
        let paginationToken: string | undefined = undefined;

        // 1. Fetch all vector IDs that start with this specific task's ID
        do {
          const listResult = await ns.listPaginated({
            prefix: `${taskId}#`,
            paginationToken,
          });

          if (listResult.vectors && listResult.vectors.length > 0) {
            chunkIds.push(...listResult.vectors.map(v => v.id as string));
          }

          paginationToken = listResult.pagination?.next;
        } while (paginationToken);

        // 2. Delete the exact IDs directly (100% supported on all serverless regions)
        if (chunkIds.length > 0) {
          await ns.deleteMany(chunkIds);
        }
      });
    },

    /**
     * Vector V2: Batch-upsert generation-scoped vectors to tenant namespace.
     */
    async upsertGenerationVectors(records: PineconeRecordV2[]) {
      const sanitized = records.map((r) => PineconeRecordV2Schema.parse(r));
      return executeWithFailover("upsertGenerationVectors", (ns) =>
        ns.upsert({ records: sanitized as PineconeRecord<RecordMetadata>[] })
      );
    },

    /**
     * Vector V2: Fetch generation-scoped vectors by IDs from tenant namespace.
     */
    async fetchGenerationVectors(ids: string[]) {
      return executeWithFailover("fetchGenerationVectors", (ns) =>
        ns.fetch({ ids })
      );
    },
  };
}

// -----------------------------------------------------------------------------
// Vector V2: Physical Persistence Verification & Bounded Polling
// -----------------------------------------------------------------------------

export interface VerifiedVectorMetadata {
  contractVersion?: string | number;
  generationId?: string;
  sourceRevision?: number;
  chunkIndex?: number;
  entityId?: string;
  entityType?: string;
  orgId?: string;
  chunkCount?: number;
  text?: string;
  contentHash?: string;
  [key: string]: unknown;
}

export interface VerifiedVectorRecord {
  id: string;
  values?: number[];
  metadata?: VerifiedVectorMetadata;
}

export interface VerifyPersistenceParams {
  orgId: string;
  generationId: string;
  entityType: 'task' | 'attachment';
  entityId: string;
  sourceRevision: number;
  expectedChunkCount: number;
  expectedManifestDigest: string;
  maxBudgetMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  perRequestTimeoutMs?: number;
  fetcher?: (ids: string[]) => Promise<{ records: Record<string, VerifiedVectorRecord> }>;
}

export type VerifyPersistenceResult =
  | {
      verified: true;
      manifestDigest: string;
      chunksFound: number;
      readBackLatencyMs: number;
      attempts: number;
    }
  | {
      verified: false;
      reason:
        | "TIMEOUT_BUDGET_EXCEEDED"
        | "MANIFEST_DIGEST_MISMATCH"
        | "METADATA_MISMATCH"
        | "DIMENSION_MISMATCH"
        | "CORRUPTED_ID";
      missingIds?: string[];
      expectedManifestDigest?: string;
      actualManifestDigest?: string;
      attempts: number;
      elapsedMs: number;
      detail?: string;
    };

/**
 * Verifies physical persistence in Pinecone using bounded read-back polling.
 * Enforces:
 * 1. Monotonic elapsed time bounding via performance.now().
 * 2. Per-request timeout capping using Promise.race.
 * 3. Exact matching of chunk indices [0..N-1], metadata, dimensions, and manifest digest.
 */
export async function verifyPhysicalPersistence({
  orgId,
  generationId,
  entityType,
  entityId,
  sourceRevision,
  expectedChunkCount,
  expectedManifestDigest,
  maxBudgetMs = 5000,
  initialDelayMs = 200,
  maxDelayMs = 2000,
  perRequestTimeoutMs = 5000,
  fetcher,
}: VerifyPersistenceParams): Promise<VerifyPersistenceResult> {
  // Correction B: Validate expectedManifestDigest before performing provider read-back
  const sha256Regex = /^[a-f0-9]{64}$/;
  if (
    typeof expectedManifestDigest !== "string" ||
    expectedManifestDigest.trim() === "" ||
    !sha256Regex.test(expectedManifestDigest.trim())
  ) {
    return {
      verified: false,
      reason: "MANIFEST_DIGEST_MISMATCH",
      expectedManifestDigest: typeof expectedManifestDigest === "string" ? expectedManifestDigest : String(expectedManifestDigest ?? ""),
      actualManifestDigest: "",
      attempts: 0,
      elapsedMs: 0,
      detail: "Missing, empty, or malformed expected manifest digest; canonical 64-char lowercase hex SHA-256 required",
    };
  }

  const expectedIds: string[] = [];
  for (let i = 0; i < expectedChunkCount; i++) {
    expectedIds.push(buildVectorId(entityType, entityId, generationId, i));
  }

  const startTime = performance.now();
  let delay = initialDelayMs;
  let attempts = 0;
  let lastMissingIds: string[] = expectedIds;

  const tenantStore = fetcher ? null : getTenantVectorStore(orgId);

  while (true) {
    attempts++;
    const elapsed = performance.now() - startTime;
    if (elapsed >= maxBudgetMs) {
      return {
        verified: false,
        reason: "TIMEOUT_BUDGET_EXCEEDED",
        missingIds: lastMissingIds,
        attempts,
        elapsedMs: Math.round(elapsed),
      };
    }

    const remainingBudgetForCall = maxBudgetMs - (performance.now() - startTime);
    const boundedTimeoutMs = Math.min(perRequestTimeoutMs, Math.max(1, remainingBudgetForCall));

    try {
      const fetchPromise = fetcher
        ? fetcher(expectedIds)
        : tenantStore!.fetchGenerationVectors(expectedIds);

      let timerHandle: NodeJS.Timeout | undefined;
      let response: { records?: Record<string, VerifiedVectorRecord> };
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timerHandle = setTimeout(() => reject(new Error("PINECONE_FETCH_TIMEOUT")), boundedTimeoutMs);
          timerHandle.unref();
        });

        response = await Promise.race([fetchPromise, timeoutPromise]);
      } finally {
        if (timerHandle) clearTimeout(timerHandle);
      }

      const recordsMap = response.records || {};

      // If fetch settled after deadline expired, fail closed immediately
      if (performance.now() - startTime >= maxBudgetMs) {
        return {
          verified: false,
          reason: "TIMEOUT_BUDGET_EXCEEDED",
          missingIds: lastMissingIds,
          attempts,
          elapsedMs: Math.round(performance.now() - startTime),
        };
      }

      const missing = expectedIds.filter(
        (id) => !(id in recordsMap) || recordsMap[id] === undefined
      );
      lastMissingIds = missing;

      if (missing.length === 0) {
        const recordKeys = Object.keys(recordsMap);
        if (recordKeys.length !== expectedChunkCount) {
          return {
            verified: false,
            reason: "CORRUPTED_ID",
            attempts,
            elapsedMs: Math.round(performance.now() - startTime),
            detail: `Expected ${expectedChunkCount} records, got ${recordKeys.length}`,
          };
        }

        const unexpectedKeys = recordKeys.filter((k) => !expectedIds.includes(k));
        if (unexpectedKeys.length > 0) {
          return {
            verified: false,
            reason: "CORRUPTED_ID",
            attempts,
            elapsedMs: Math.round(performance.now() - startTime),
            detail: `Unexpected record IDs in response: ${unexpectedKeys.join(", ")}`,
          };
        }

        // All expected records returned. Validate identity, metadata, dimensions, and finite numeric values.
        const fetchedChunks: Array<{
          chunkIndex: number;
          id: string;
          text?: string;
          contentHash?: string;
        }> = [];

        let metadataValid = true;
        let failureResult: VerifyPersistenceResult | null = null;

        for (let i = 0; i < expectedChunkCount; i++) {
          const id = expectedIds[i];
          const rec = recordsMap[id];

          if (!rec || typeof rec !== "object") {
            failureResult = {
              verified: false,
              reason: "CORRUPTED_ID",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Record ${id} is not an object`,
            };
            metadataValid = false;
            break;
          }

          if (typeof rec.id !== "string" || rec.id !== id) {
            failureResult = {
              verified: false,
              reason: "CORRUPTED_ID",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Record ID property mismatch or missing: expected ${id}, got ${rec.id}`,
            };
            metadataValid = false;
            break;
          }

          const parsed = parseVectorId(id);
          if (
            !parsed ||
            parsed.chunkIndex !== i ||
            parsed.generationId !== generationId ||
            parsed.entityId !== entityId ||
            parsed.entityType !== entityType
          ) {
            failureResult = {
              verified: false,
              reason: "CORRUPTED_ID",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Failed to parse vector ID or mismatch in parsed ID components for ${id}`,
            };
            metadataValid = false;
            break;
          }

          const meta = rec.metadata;
          if (!meta || typeof meta !== "object") {
            failureResult = {
              verified: false,
              reason: "METADATA_MISMATCH",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Missing metadata on chunk ${id}`,
            };
            metadataValid = false;
            break;
          }

          if (
            meta.contractVersion !== "v2" ||
            meta.generationId !== generationId ||
            meta.sourceRevision !== sourceRevision ||
            typeof meta.chunkIndex !== "number" ||
            meta.chunkIndex !== i ||
            meta.entityId !== entityId ||
            meta.entityType !== entityType ||
            meta.orgId !== orgId ||
            typeof meta.chunkCount !== "number" ||
            meta.chunkCount !== expectedChunkCount
          ) {
            failureResult = {
              verified: false,
              reason: "METADATA_MISMATCH",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Metadata mismatch on chunk ${id}: gen=${meta.generationId}, rev=${meta.sourceRevision}, chunkIndex=${meta.chunkIndex}, orgId=${meta.orgId}`,
            };
            metadataValid = false;
            break;
          }

          if (typeof meta.text !== "string" || meta.text.length === 0) {
            failureResult = {
              verified: false,
              reason: "METADATA_MISMATCH",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Missing or invalid text metadata required for manifest reconstruction on chunk ${id}`,
            };
            metadataValid = false;
            break;
          }

          // Strict Physical Vector Validation (DIMENSION & VALUES)
          if (!Array.isArray(rec.values)) {
            failureResult = {
              verified: false,
              reason: "DIMENSION_MISMATCH",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Vector values missing or not an array on chunk ${id}`,
            };
            metadataValid = false;
            break;
          }

          if (rec.values.length !== 768) {
            failureResult = {
              verified: false,
              reason: "DIMENSION_MISMATCH",
              attempts,
              elapsedMs: Math.round(performance.now() - startTime),
              detail: `Dimension mismatch on chunk ${id}: expected 768, got ${rec.values.length}`,
            };
            metadataValid = false;
            break;
          }

          let valuesValid = true;
          for (let d = 0; d < 768; d++) {
            if (!(d in rec.values)) {
              failureResult = {
                verified: false,
                reason: "DIMENSION_MISMATCH",
                attempts,
                elapsedMs: Math.round(performance.now() - startTime),
                detail: `Sparse array hole at dimension ${d} on chunk ${id}`,
              };
              valuesValid = false;
              break;
            }
            const val = rec.values[d];
            if (typeof val !== "number" || !Number.isFinite(val)) {
              failureResult = {
                verified: false,
                reason: "DIMENSION_MISMATCH",
                attempts,
                elapsedMs: Math.round(performance.now() - startTime),
                detail: `Invalid vector value at dimension ${d} on chunk ${id}: ${typeof val} (${val})`,
              };
              valuesValid = false;
              break;
            }
          }

          if (!valuesValid) {
            metadataValid = false;
            break;
          }

          fetchedChunks.push({
            chunkIndex: i,
            id,
            text: meta.text,
            contentHash: meta.contentHash,
          });
        }

        if (!metadataValid && failureResult) {
          return failureResult;
        }

        const computedDigest = computeManifestDigest(fetchedChunks);
        if (computedDigest !== expectedManifestDigest.trim()) {
          return {
            verified: false,
            reason: "MANIFEST_DIGEST_MISMATCH",
            expectedManifestDigest,
            actualManifestDigest: computedDigest,
            attempts,
            elapsedMs: Math.round(performance.now() - startTime),
            detail: `Manifest digest mismatch: expected ${expectedManifestDigest}, got ${computedDigest}`,
          };
        }

        const totalElapsed = performance.now() - startTime;
        if (totalElapsed >= maxBudgetMs) {
          return {
            verified: false,
            reason: "TIMEOUT_BUDGET_EXCEEDED",
            missingIds: [],
            attempts,
            elapsedMs: Math.round(totalElapsed),
            detail: `Verification exceeded maximum budget of ${maxBudgetMs}ms`,
          };
        }

        return {
          verified: true,
          manifestDigest: computedDigest,
          chunksFound: expectedChunkCount,
          readBackLatencyMs: Math.round(totalElapsed),
          attempts,
        };
      }
    } catch (fetchErr: unknown) {
      const err = fetchErr as { status?: number; statusCode?: number; response?: { status?: number }; message?: string } | null | undefined;
      const status = err?.status ?? err?.statusCode ?? err?.response?.status;
      const errMsg = String(err?.message || fetchErr);
      if (
        status === 401 ||
        status === 403 ||
        errMsg.includes("Unauthorized") ||
        errMsg.includes("Forbidden") ||
        errMsg.includes("API key")
      ) {
        return {
          verified: false,
          reason: "METADATA_MISMATCH",
          attempts,
          elapsedMs: Math.round(performance.now() - startTime),
          detail: `Fatal Pinecone authentication error: ${errMsg}`,
        };
      }
      // Transient fetch error or timeout; retry while budget remains
    }

    const remainingBudget = maxBudgetMs - (performance.now() - startTime);
    if (remainingBudget <= 50) {
      return {
        verified: false,
        reason: "TIMEOUT_BUDGET_EXCEEDED",
        missingIds: lastMissingIds,
        attempts,
        elapsedMs: Math.round(performance.now() - startTime),
      };
    }

    const jitter = Math.floor(Math.random() * 50);
    const sleepMs = Math.min(delay + jitter, maxDelayMs, remainingBudget);
    await new Promise((r) => {
      const t = setTimeout(r, sleepMs);
      t.unref();
    });
    delay = Math.min(delay * 1.5, maxDelayMs);
  }
}