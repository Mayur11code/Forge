import "server-only";
// src/lib/vector/client.ts
import { Pinecone } from '@pinecone-database/pinecone';
import { VectorMetadata, PineconeRecordSchema } from './schema';
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
// By passing the Generic <VectorMetadata>, the Pinecone SDK automatically provides
// type checking and autocomplete for our specific metadata fields on queries.
export const getRawPineconeIndex = () => pinecone.index<VectorMetadata>(indexName);




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
  };
}