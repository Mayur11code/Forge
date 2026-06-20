// src/app/api/worker/embedding-worker/ew.ts
import { prisma } from "@/lib/prisma/extended";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getTenantVectorStore } from "@/lib/vector/client";
import { buildSemanticPayload } from "@/lib/vector/text-extractor";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {

    type EmbedContentRequest,
    TaskType,
} from "@google/generative-ai";

// 1. Initialize Gemini Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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

        // 4. Batch Embeddings with Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

        // Format chunks for Gemini's batch endpoint
        const embeddingRequests: EmbedContentRequest[] = chunks.map((chunkText) => ({
            content: {
                role: "user",
                parts: [{ text: chunkText }],
            },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
            outputDimensionality: 768,
        }));

        const result = await model.batchEmbedContents({
            requests: embeddingRequests,
        });

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

    } catch (error: any) {
        console.error("❌ [EMBEDDING] Worker Execution Error:", error);
        throw error;
    }
}