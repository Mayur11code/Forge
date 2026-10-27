// src/lib/vector/retriever.ts
import { embed } from 'ai';
import { resolveOrganizationEmbeddingModel } from '@/lib/ai/resolver';
import { getTenantVectorStore } from './client';
import { db } from '@/lib/prisma/db';

/**
 * Verifies that candidate vector matches correspond to active, existing records in the database
 * belonging to the specified tenant organization.
 * Filters out stale vectors from tasks or attachments that have been deleted in PostgreSQL
 * during the asynchronous Pinecone cleanup window.
 */
export async function filterActiveRagCandidates(
    matches: Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>,
    orgId: string
) {
    if (!matches || matches.length === 0) return [];

    const taskCandidateIds = new Set<string>();
    const attachmentCandidateIds = new Set<string>();

    for (const match of matches) {
        const entityId = match.id.split("#")[0];
        const type = match.metadata?.type;
        const taskId = typeof match.metadata?.taskId === "string" ? match.metadata.taskId : undefined;

        if (type === "document") {
            if (entityId) attachmentCandidateIds.add(entityId);
            if (taskId) taskCandidateIds.add(taskId);
        } else {
            // Task vector
            const idToVerify = taskId || entityId;
            if (idToVerify) taskCandidateIds.add(idToVerify);
        }
    }

    // Execute bounded, batched lookups
    const [existingTasks, existingAttachments] = await Promise.all([
        taskCandidateIds.size > 0
            ? db.task.findMany({
                  where: {
                      id: { in: Array.from(taskCandidateIds) },
                      project: { orgId },
                  },
                  select: { id: true },
              })
            : [],
        attachmentCandidateIds.size > 0
            ? db.attachment.findMany({
                  where: {
                      id: { in: Array.from(attachmentCandidateIds) },
                      task: { project: { orgId } },
                  },
                  select: { id: true, taskId: true },
              })
            : [],
    ]);

    const activeTaskIds = new Set(existingTasks.map((t) => t.id));
    const activeAttachmentIds = new Set(existingAttachments.map((a) => a.id));

    // Filter matches: only retain chunks whose underlying resources exist and belong to orgId
    return matches.filter((match) => {
        const entityId = match.id.split("#")[0];
        const type = match.metadata?.type;
        const taskId = typeof match.metadata?.taskId === "string" ? match.metadata.taskId : undefined;

        if (type === "document") {
            // Document chunk requires both attachment and parent task to exist in org
            if (!activeAttachmentIds.has(entityId)) return false;
            if (taskId && !activeTaskIds.has(taskId)) return false;
            return true;
        } else {
            // Task chunk requires task to exist in org
            const idToVerify = taskId || entityId;
            return activeTaskIds.has(idToVerify);
        }
    });
}

/**
 * Converts a raw user query string into a vector embedding using the global provider,
 * queries the isolated tenant vector space, and formats the hits into a semantic context block.
 */
export async function retrieveRelevantContext(
    userQuery: string,
    orgId: string
): Promise<string> {
    try {
        if (!userQuery || !userQuery.trim()) return "";
        if (!orgId) throw new Error("CRITICAL: Tenant isolation key (orgId) missing during retrieval.");

        // 1. Generate Query Vector Embedding via the Global Singleton Provider
        const { embedding } = await embed({
            model: await resolveOrganizationEmbeddingModel({ orgId }),
            value: userQuery,
            providerOptions: {
                google: {
                    outputDimensionality: 768,
                } 
            },
        });

        if (!embedding || embedding.length === 0) {
            console.error("❌ [RETRIEVER] Failed to extract vector values from the global provider.");
            return "";
        }

        // 2. Fetch Isolated Tenant Vector Store Instance
        const vectorStore = getTenantVectorStore(orgId);

        // 3. Query the Namespace
        // Pull the top 5 most semantically relevant chunks from Pinecone
        const searchHits = await vectorStore.query(embedding, 5);

        if (!searchHits.matches || searchHits.matches.length === 0) {
            return "";
        }

        // 4. Guard against stale vectors: batch-validate that resources still exist in DB
        const activeMatches = await filterActiveRagCandidates(
            searchHits.matches as Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>,
            orgId
        );

        if (activeMatches.length === 0) {
            return "";
        }

        // 5. Assemble and Format the Context Block
        const compiledContextBlocks = activeMatches
            .map((hit, index) => {
                const textPayload = typeof hit.metadata?.text === "string" ? hit.metadata.text : undefined;
                if (!textPayload) return null;

                // Extract relational variables if they exist on metadata
                const taskId = hit.metadata?.taskId || "Unknown ID";
                const scorePercentage = Math.round(hit.score ? hit.score * 100 : 0);

                return `[Context Chunk #${index + 1} | Source Task ID: ${taskId} | Semantic Match: ${scorePercentage}%]\n${textPayload}`;
            })
            .filter(Boolean)
            .join("\n\n---\n\n");

        return compiledContextBlocks;

    } catch (error: unknown) {
        console.error("❌ [RETRIEVER_ERROR]: Execution failed during context generation ->", error);
        // Return empty string gracefully so the Chat API can fall back to general assistant instructions
        return "";
    }
}
