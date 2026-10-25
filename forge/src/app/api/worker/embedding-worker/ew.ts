import "server-only";
// src/app/api/worker/embedding-worker/ew.ts
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore } from "@/lib/vector/client";
import { buildSemanticPayload } from "@/lib/vector/text-extractor";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
    type EmbedContentRequest,
    TaskType,
} from "@google/generative-ai";
import {
    isGeminiAuthenticationError,
    logCredentialFailover,
} from "@/lib/security/credential-rotation";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { CredentialPurpose } from "@prisma/client";

// 1. PERFECTLY MATCH THE ZOD SCHEMA
interface EmbeddingEventParams {
  event: {
    id: string;
    type: "EMBEDDING_REQUESTED";
    data: {
      orgId: string;
      entityId: string;
      type: "TASK" | "ATTACHMENT";
      actorId?: string;
    };
    time: string;
  }
}

export async function embeddingWorkerHandler({ event }: EmbeddingEventParams): Promise<void> {
    try {
    // We now destructure entityId instead of taskId
    const { entityId, orgId, type } = event.data;

        if (!entityId || !orgId) {
            console.error("❌ [EMBEDDING] Missing routing parameters", event.data);
            return;
        }

        const vectorStore = getTenantVectorStore(orgId);

        // 1. WIPE PROTOCOL
        console.log(`[EMBEDDING] Wiping old vectors for entity: ${entityId}`);
        await vectorStore.deleteByTask(entityId);

        // 2. Fetch current state
        const task = await prisma.task.findUnique({ where: { id: entityId } });

        if (!task) {
            console.log(`[EMBEDDING] Task ${entityId} deleted or not found. Wipe complete.`);
            return;
        }

        // 3. Hydrate & Chunk
        const cleanText = buildSemanticPayload(task);
        const chunks = await chunkTextSemantically(cleanText);

        if (chunks.length === 0) {
            console.log(`[EMBEDDING] Task ${entityId} yielded an empty payload.`);
            return;
        }

        console.log(`[EMBEDDING] Slicing task into ${chunks.length} semantic chunks.`);

        // 4. Batch Embeddings with Organization-Aware Resolver
        const resolvedAi = await resolveOrganizationGenerativeAiClient({
            orgId,
            purpose: CredentialPurpose.EMBEDDING,
        });
        const activePrimary = resolvedAi.client.getGenerativeModel({ model: "gemini-embedding-001" });
        const fallbackModel = resolvedAi.fallbackClient
            ? resolvedAi.fallbackClient.getGenerativeModel({ model: "gemini-embedding-001" })
            : null;

        // Format chunks for Gemini's batch endpoint
        const embeddingRequests: EmbedContentRequest[] = chunks.map((chunkText) => ({
            content: {
                role: "user",
                parts: [{ text: chunkText }],
            },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
            outputDimensionality: 768,
        }));

        let result;
        try {
            result = await activePrimary.batchEmbedContents({
                requests: embeddingRequests,
            });
        } catch (err) {
            if (fallbackModel && isGeminiAuthenticationError(err)) {
                logCredentialFailover({
                    provider: "gemini",
                    subsystem: "embedding-worker",
                    slot: "primary",
                    operation: "batchEmbedContents",
                    errorCategory: "AUTH_FAILURE_FAILOVER",
                    message: err instanceof Error ? err.message : String(err),
                });
                result = await fallbackModel.batchEmbedContents({
                    requests: embeddingRequests,
                });
            } else {
                throw err;
            }
        }

        // Extract the raw numerical arrays from the Gemini response
        const embeddings = result.embeddings.map(e => e.values);

        // 5. Rewrite to Pinecone
        const upsertPromises = chunks.map((chunkText, i) => {
            const deterministicId = `${entityId}#${i}`;

            return vectorStore.upsert(
                deterministicId,
                embeddings[i],
                {
                    text: chunkText,
                    taskId: entityId,
                    projectId: task.projectId || "",
                    type: "task" as const
                }
            );
        });

        await Promise.all(upsertPromises);
        console.log(`✅ [EMBEDDING] Successfully synchronized ${chunks.length} chunks to Pinecone via Gemini.`);

    } catch (error: unknown) {
        console.error("❌ [EMBEDDING] Worker Execution Error:", error);
        throw error;
    }
}