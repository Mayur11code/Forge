// src/app/api/worker/embedding-worker/ew.ts
import { prisma } from "@/lib/prisma/extended";
import OpenAI from "openai";
import { getTenantVectorStore } from "@/lib/vector/client";
import { buildSemanticPayload } from "@/lib/vector/text-extractor";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";

const openai = new OpenAI();

interface TaskEventParams {
  event: {
    type: string;
    data: {
      taskId: string;
      orgId: string;
      projectId: string;
      actorId?: string;
    }
  }
}

export async function embeddingWorkerHandler({ event }: TaskEventParams): Promise<void> {
  try {
    const { taskId, orgId, projectId } = event.data;
    
    if (!taskId || !orgId) {
      console.error("❌ [EMBEDDING] Missing routing parameters", event.data);
      return; // Return void
    }

    const vectorStore = getTenantVectorStore(orgId);

    // 1. WIPE PROTOCOL
    console.log(`[EMBEDDING] Wiping old vectors for task: ${taskId}`);
    await vectorStore.deleteByTask(taskId);

    // 2. Fetch current state
    const task = await prisma.task.findUnique({ where: { id: taskId } });

    if (!task) {
      console.log(`[EMBEDDING] Task ${taskId} deleted or not found. Wipe complete.`);
      return; // Return void
    }

    // 3. Hydrate & Chunk
    const cleanText = buildSemanticPayload(task);
    const chunks = await chunkTextSemantically(cleanText);

    if (chunks.length === 0) {
       console.log(`[EMBEDDING] Task ${taskId} yielded an empty payload.`);
       return; // Return void
    }

    console.log(`[EMBEDDING] Slicing task into ${chunks.length} semantic chunks.`);

    // 4. Parallel Embeddings
    const embeddingPromises = chunks.map(chunk => 
      openai.embeddings.create({ model: "text-embedding-3-small", input: chunk })
    );
    const embeddingResults = await Promise.all(embeddingPromises);

    // 5. Rewrite
    const upsertPromises = chunks.map((chunkText, i) => {
      const deterministicId = `${task.id}#${i}`; 
      
      return vectorStore.upsert(
        deterministicId,
        embeddingResults[i].data[0].embedding,
        {
          text: chunkText,
          taskId: task.id,       
          projectId: projectId || "", 
          type: "task" as const  
        }
      );
    });

    await Promise.all(upsertPromises);
    console.log(`✅ [EMBEDDING] Successfully synchronized ${chunks.length} chunks to Pinecone.`);

  } catch (error: any) {
    console.error("❌ [EMBEDDING] Worker Execution Error:", error);
    
    // Throw the error back up so createWorker / QStash knows it failed 
    // and can handle retries/backoff status codes automatically
    throw error;
  }
}