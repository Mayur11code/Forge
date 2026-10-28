// src/lib/vector/retriever.ts
import { embed } from 'ai';
import { resolveOrganizationEmbeddingModel } from '@/lib/ai/resolver';
import { getTenantVectorStore } from './client';
import { db } from '@/lib/prisma/db';
import {
    resolveSourceProvenance,
    type SourceProvenance,
    type SourceRef,
} from './provenance';

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
 * @deprecated Provenance is no longer reconstructed by parsing the formatted
 * context string: that silently dropped sources ("Unknown ID" chunks), never
 * recorded attachment ids, and carried no versions. Use
 * `retrieveRelevantContextWithProvenance`, which returns structured provenance.
 */
export function extractTaskIdsFromContext(context: string): string[] {
    if (!context || typeof context !== "string") return [];
    const matches = context.matchAll(/Source Task ID:\s*([^\s|\]]+)/g);
    const ids = new Set<string>();
    for (const m of matches) {
        const id = m[1]?.trim();
        if (id && id !== "Unknown" && id !== "Unknown ID") {
            ids.add(id);
        }
    }
    return Array.from(ids);
}

export interface RetrievedContext {
    context: string;
    /**
     * Every record that produced the returned context, with the content version
     * observed at retrieval time. Empty when provenance was not collected.
     */
    provenance: SourceProvenance[];
    /**
     * True only when provenance was collected AND every contributing source was
     * positively identified and loaded inside the organization. The semantic
     * cache refuses to store answers whose provenance is not complete.
     */
    provenanceComplete: boolean;
}

/**
 * Maps vector matches to the source records they were built from.
 *
 * A "document" chunk is built from an attachment whose text also embeds the
 * parent task's title/identifiers, so the parent task is an input to the chunk
 * and is recorded as a separate source. An unknown or unattributable match makes
 * provenance incomplete rather than being guessed at.
 */
function refsFromMatches(
    matches: Array<{ id: string; metadata?: Record<string, unknown> }>
): { refs: SourceRef[]; complete: boolean } {
    const refs: SourceRef[] = [];
    let complete = true;

    for (const match of matches) {
        const entityId = match.id.split("#")[0];
        const type = match.metadata?.type;
        const taskId =
            typeof match.metadata?.taskId === "string"
                ? match.metadata.taskId
                : undefined;

        if (!entityId) {
            complete = false;
            continue;
        }

        if (type === "document") {
            refs.push({ type: "attachment", id: entityId });
            if (taskId) {
                refs.push({ type: "task", id: taskId });
            } else {
                // Attachment chunk text embeds the parent task; without its id
                // the chunk's inputs cannot be re-validated.
                complete = false;
            }
        } else if (type === "task") {
            refs.push({ type: "task", id: taskId ?? entityId });
        } else {
            // Source kind is not one the embedding worker produces.
            complete = false;
        }
    }

    return { refs, complete };
}

async function runRetrieval(
    userQuery: string,
    orgId: string,
    precomputedEmbedding: number[] | undefined,
    collectProvenance: boolean
): Promise<RetrievedContext> {
    try {
        if (!userQuery || !userQuery.trim()) {
            return { context: "", provenance: [], provenanceComplete: false };
        }
        if (!orgId) throw new Error("CRITICAL: Tenant isolation key (orgId) missing during retrieval.");

        // 1. Reuse precomputed embedding if supplied; otherwise generate via provider
        let embedding = precomputedEmbedding;
        if (!embedding || embedding.length === 0) {
            const embedResult = await embed({
                model: await resolveOrganizationEmbeddingModel({ orgId }),
                value: userQuery,
                providerOptions: {
                    google: {
                        outputDimensionality: 768,
                    }
                },
            });
            embedding = embedResult.embedding;
        }

        if (!embedding || embedding.length === 0) {
            console.error("❌ [RETRIEVER] Failed to extract vector values from the global provider.");
            return { context: "", provenance: [], provenanceComplete: false };
        }

        // 2. Fetch Isolated Tenant Vector Store Instance
        const vectorStore = getTenantVectorStore(orgId);

        // 3. Query the Namespace
        // Pull the top 5 most semantically relevant chunks from Pinecone
        const searchHits = await vectorStore.query(embedding, 5);

        if (!searchHits.matches || searchHits.matches.length === 0) {
            return { context: "", provenance: [], provenanceComplete: false };
        }

        // 4. Guard against stale vectors: batch-validate that resources still exist in DB
        const activeMatches = await filterActiveRagCandidates(
            searchHits.matches as Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>,
            orgId
        );

        if (activeMatches.length === 0) {
            return { context: "", provenance: [], provenanceComplete: false };
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

        if (!collectProvenance) {
            return { context: compiledContextBlocks, provenance: [], provenanceComplete: false };
        }

        // 6. Capture structured provenance with the versions observed right now.
        const { refs, complete: refsComplete } = refsFromMatches(activeMatches);
        const resolved = await resolveSourceProvenance(orgId, refs);

        return {
            context: compiledContextBlocks,
            provenance: resolved.sources,
            provenanceComplete:
                refsComplete &&
                resolved.complete &&
                resolved.sources.length > 0,
        };

    } catch (error: unknown) {
        console.error("❌ [RETRIEVER_ERROR]: Execution failed during context generation ->", error);
        // Return empty context gracefully so the Chat API can fall back to general assistant instructions
        return { context: "", provenance: [], provenanceComplete: false };
    }
}

/**
 * Converts a raw user query string into a vector embedding using the global provider,
 * queries the isolated tenant vector space, and formats the hits into a semantic context block.
 *
 * If a precomputed query vector embedding is provided (e.g. from the semantic cache lookup),
 * it is reused directly, avoiding a redundant second embedding API call.
 */
export async function retrieveRelevantContext(
    userQuery: string,
    orgId: string,
    precomputedEmbedding?: number[]
): Promise<string> {
    const result = await runRetrieval(userQuery, orgId, precomputedEmbedding, false);
    return result.context;
}

/**
 * Retrieval variant that additionally returns structured, versioned provenance
 * for every source that contributed to the context. Required for any response
 * that may be written to the semantic cache.
 */
export async function retrieveRelevantContextWithProvenance(
    userQuery: string,
    orgId: string,
    precomputedEmbedding?: number[]
): Promise<RetrievedContext> {
    return runRetrieval(userQuery, orgId, precomputedEmbedding, true);
}
