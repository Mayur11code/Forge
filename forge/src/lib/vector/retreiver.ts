// src/lib/vector/retriever.ts
import { embed } from 'ai';
import { resolveOrganizationEmbeddingModel } from '@/lib/ai/resolver';
import { getTenantVectorStore } from './client';
import { db } from '@/lib/prisma/db';
import { Prisma, VectorEntityType } from '@prisma/client';
import { parseVectorId } from './schema';
import {
    taskSourceVersion,
    attachmentSourceVersion,
    type SourceProvenance,
} from './provenance';

export const MAX_SUPPORTED_TOP_K = 25;

export type ActiveRagCandidatePrismaClient = {
    vectorEntityHead?: {
        findMany: (args: Prisma.VectorEntityHeadFindManyArgs) => Promise<Array<{
            entityType: VectorEntityType;
            entityId: string;
            activeGenId: string | null;
            latestRevision: number;
            isTombstone: boolean;
        }>>;
    };
    task?: {
        findMany: (args: Prisma.TaskFindManyArgs) => Promise<Array<{ id: string }>>;
    };
    attachment?: {
        findMany: (args: Prisma.AttachmentFindManyArgs) => Promise<Array<{ id: string; taskId?: string }>>;
    };
} | typeof db;

export interface ActiveRagCandidateFilterOptions {
    prismaClient?: ActiveRagCandidatePrismaClient;
}

/**
 * Verifies that candidate vector matches correspond to active, authoritative records
 * belonging to the specified tenant organization.
 *
 * Vector V2 Active-Generation Enforcement:
 * 1. Parses `${entityType}_${entityId}_${generationId}#${chunkIndex}`.
 * 2. Asserts id.generationId === metadata.generationId, metadata.contractVersion === "v2".
 * 3. Resolves VectorEntityHead:
 *    - If head.isTombstone: REJECT.
 *    - If head.activeGenId === null: REJECT.
 *    - If candidate.generationId !== head.activeGenId: REJECT (superseded/obsolete).
 *    - If metadata.sourceRevision !== head.latestRevision: REJECT.
 * 4. Legacy V1 candidates are rejected if the entity already has an active V2 generation.
 */
export async function filterActiveRagCandidates(
    matches: Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>,
    orgId: string,
    options?: ActiveRagCandidateFilterOptions
) {
    if (!matches || matches.length === 0) return [];

    const prismaDb = options?.prismaClient ?? db;

    interface ParsedCandidate {
        match: typeof matches[0];
        isV2: boolean;
        entityType?: 'task' | 'attachment';
        entityId?: string;
        generationId?: string;
        chunkIndex?: number;
        sourceRevision?: number;
    }

    const parsedCandidates: ParsedCandidate[] = [];
    const v2EntitiesToLookup: Array<{ entityType: VectorEntityType; entityId: string }> = [];
    const legacyTaskIds = new Set<string>();
    const legacyAttachmentIds = new Set<string>();

    for (const match of matches) {
        const meta = match.metadata ?? {};
        const parsedId = parseVectorId(match.id);

        if (parsedId && meta.contractVersion === 'v2') {
            // V2 candidate: verify consistency between parsed ID and metadata
            if (
                parsedId.generationId === meta.generationId &&
                parsedId.entityId === meta.entityId &&
                parsedId.entityType === meta.entityType &&
                parsedId.chunkIndex === meta.chunkIndex &&
                typeof meta.sourceRevision === 'number'
            ) {
                const pType = parsedId.entityType === 'task' ? VectorEntityType.TASK : VectorEntityType.ATTACHMENT;
                parsedCandidates.push({
                    match,
                    isV2: true,
                    entityType: parsedId.entityType,
                    entityId: parsedId.entityId,
                    generationId: parsedId.generationId,
                    chunkIndex: parsedId.chunkIndex,
                    sourceRevision: meta.sourceRevision as number,
                });
                v2EntitiesToLookup.push({ entityType: pType, entityId: parsedId.entityId });
            } else {
                // Corrupted or mismatched metadata/ID
                continue;
            }
        } else {
            // Legacy V1 candidate
            const entityId = match.id.split('#')[0];
            const type = meta.type;
            const taskId = typeof meta.taskId === 'string' ? meta.taskId : undefined;
            const isDoc = type === 'document';
            const legacyEntityType = isDoc ? VectorEntityType.ATTACHMENT : VectorEntityType.TASK;

            parsedCandidates.push({
                match,
                isV2: false,
                entityType: isDoc ? 'attachment' : 'task',
                entityId,
            });

            if (entityId) {
                v2EntitiesToLookup.push({ entityType: legacyEntityType, entityId });
            }

            if (type === 'document') {
                if (entityId) legacyAttachmentIds.add(entityId);
                if (taskId) legacyTaskIds.add(taskId);
            } else {
                const idToVerify = taskId || entityId;
                if (idToVerify) legacyTaskIds.add(idToVerify);
            }
        }
    }

    // Execute bounded, batched lookups
    const [heads, legacyTasks, legacyAttachments] = await Promise.all([
        v2EntitiesToLookup.length > 0 && typeof prismaDb.vectorEntityHead?.findMany === 'function'
            ? prismaDb.vectorEntityHead.findMany({
                  where: {
                      orgId,
                      OR: v2EntitiesToLookup.map((e) => ({
                          entityType: e.entityType,
                          entityId: e.entityId,
                      })),
                  },
                  select: {
                      entityType: true,
                      entityId: true,
                      activeGenId: true,
                      latestRevision: true,
                      isTombstone: true,
                  },
              })
            : [],
        legacyTaskIds.size > 0 && typeof prismaDb.task?.findMany === 'function'
            ? prismaDb.task.findMany({
                  where: {
                      id: { in: Array.from(legacyTaskIds) },
                      project: { orgId },
                  },
                  select: { id: true },
              })
            : [],
        legacyAttachmentIds.size > 0 && typeof prismaDb.attachment?.findMany === 'function'
            ? prismaDb.attachment.findMany({
                  where: {
                      id: { in: Array.from(legacyAttachmentIds) },
                      task: { project: { orgId } },
                  },
                  select: { id: true, taskId: true },
              })
            : [],
    ]);

    // Index heads by `${entityType}:${entityId}`
    const headMap = new Map<string, typeof heads[0]>();
    for (const h of heads) {
        headMap.set(`${h.entityType}:${h.entityId}`, h);
    }

    const activeLegacyTaskIds = new Set(legacyTasks.map((t: { id: string }) => t.id));
    const activeLegacyAttachmentIds = new Set(legacyAttachments.map((a: { id: string }) => a.id));

    // Filter matches: only retain chunks matching authoritative active head invariants
    const validMatches: typeof matches = [];

    for (const cand of parsedCandidates) {
        if (cand.isV2) {
            const pType = cand.entityType === 'task' ? VectorEntityType.TASK : VectorEntityType.ATTACHMENT;
            const head = headMap.get(`${pType}:${cand.entityId}`);

            if (!head) continue;
            // Head must not be tombstoned
            if (head.isTombstone) continue;
            // Head must have an active generation
            if (!head.activeGenId) continue;
            // Candidate generationId must match head.activeGenId
            if (cand.generationId !== head.activeGenId) continue;
            // Source revision in candidate metadata must equal head.latestRevision
            if (cand.sourceRevision !== head.latestRevision) continue;

            validMatches.push(cand.match);
        } else {
            // Legacy V1 candidate: check if entity already has an active V2 generation
            const taskHead = headMap.get(`${VectorEntityType.TASK}:${cand.entityId}`);
            if (taskHead?.activeGenId) continue;

            const meta = cand.match.metadata ?? {};
            const type = meta.type;
            const taskId = typeof meta.taskId === 'string' ? meta.taskId : undefined;

            if (type === 'document') {
                if (!activeLegacyAttachmentIds.has(cand.entityId!)) continue;
                if (taskId && !activeLegacyTaskIds.has(taskId)) continue;
                validMatches.push(cand.match);
            } else {
                const idToVerify = taskId || cand.entityId!;
                if (activeLegacyTaskIds.has(idToVerify)) {
                    validMatches.push(cand.match);
                }
            }
        }
    }

    return validMatches;
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

async function runRetrieval(
    userQuery: string,
    orgId: string,
    precomputedEmbedding: number[] | undefined,
    collectProvenance: boolean,
    requestedTopK: number = 5
): Promise<RetrievedContext> {
    try {
        if (!userQuery || !userQuery.trim()) {
            return { context: "", provenance: [], provenanceComplete: false };
        }
        if (!orgId) throw new Error("CRITICAL: Tenant isolation key (orgId) missing during retrieval.");

        // 1. Clamped Top-K Contract
        const parsedTopK = typeof requestedTopK === "number" && Number.isFinite(requestedTopK) ? Math.floor(requestedTopK) : 5;
        const clampedTopK = Math.min(Math.max(1, parsedTopK), MAX_SUPPORTED_TOP_K);
        // Candidate pool oversampling factor: min(clampedTopK * 2, 50)
        const queryK = Math.min(clampedTopK * 2, 50);

        // 2. Reuse precomputed embedding if supplied; otherwise generate via provider
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

        // 3. Fetch Isolated Tenant Vector Store Instance
        const vectorStore = getTenantVectorStore(orgId);

        // 4. Query the Namespace with oversampled K
        const searchHits = await vectorStore.query(embedding, queryK);
        const matches = (searchHits.matches ?? []) as Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>;

        if (!matches || matches.length === 0) {
            return { context: "", provenance: [], provenanceComplete: false };
        }

        // 5. Guard against stale vectors: batch-validate active generation & head invariants
        let activeMatches = await filterActiveRagCandidates(matches, orgId);

        // 6. Bounded Secondary Fetch:
        // Only trigger if Pinecone had more results than our initial candidate pool (matches.length >= queryK)
        // and filtered active candidates < ceil(clampedTopK / 2) and initial queryK < 50
        if (matches.length >= queryK && activeMatches.length < Math.ceil(clampedTopK / 2) && queryK < 50) {
            const secondaryHits = await vectorStore.query(embedding, 50);
            const secondaryMatches = (secondaryHits.matches ?? []) as Array<{ id: string; metadata?: Record<string, unknown>; score?: number }>;
            const existingIds = new Set(matches.map((m) => m.id));
            const newMatches = secondaryMatches.filter((m) => !existingIds.has(m.id));
            if (newMatches.length > 0) {
                const filteredNew = await filterActiveRagCandidates(newMatches, orgId);
                activeMatches = [...activeMatches, ...filteredNew];
            }
        }

        if (activeMatches.length === 0) {
            return { context: "", provenance: [], provenanceComplete: false };
        }

        // Slice to requested clampedTopK
        activeMatches = activeMatches.slice(0, clampedTopK);

        // 5. Strict Freshness Validation:
        // A vector is current only when its indexed content corresponds to the current authoritative source state.
        // Missing, legacy, or mismatched versions must be excluded from authoritative context and cache operations.
        const taskCandidateIds = new Set<string>();
        const attachmentCandidateIds = new Set<string>();

        for (const match of activeMatches) {
            const entityId = match.id.split("#")[0];
            const type = match.metadata?.type;
            const taskId = typeof match.metadata?.taskId === "string" ? match.metadata.taskId : undefined;

            if (type === "document") {
                if (entityId) attachmentCandidateIds.add(entityId);
                if (taskId) taskCandidateIds.add(taskId);
            } else if (type === "task") {
                const id = taskId || entityId;
                if (id) taskCandidateIds.add(id);
            }
        }

        const [taskRows, attachmentRows] = await Promise.all([
            taskCandidateIds.size > 0
                ? db.task.findMany({
                      where: { id: { in: Array.from(taskCandidateIds) }, project: { orgId } },
                      select: { id: true, updatedAt: true, projectId: true },
                  })
                : [],
            attachmentCandidateIds.size > 0
                ? db.attachment.findMany({
                      where: { id: { in: Array.from(attachmentCandidateIds) }, task: { project: { orgId } } },
                      select: {
                          id: true,
                          taskId: true,
                          createdAt: true,
                          size: true,
                          name: true,
                          task: { select: { updatedAt: true, projectId: true } },
                      },
                  })
                : [],
        ]);

        const liveTaskVersions = new Map<string, string>();
        for (const t of taskRows) {
            liveTaskVersions.set(t.id, taskSourceVersion(t));
        }

        const liveAttachmentVersions = new Map<string, string>();
        const liveAttachmentParentTasks = new Map<string, { taskId: string; version: string }>();
        for (const a of attachmentRows) {
            liveAttachmentVersions.set(a.id, attachmentSourceVersion(a));
            const parentVersion =
                liveTaskVersions.get(a.taskId) ||
                (a.task
                    ? taskSourceVersion({
                          updatedAt: a.task.updatedAt,
                          projectId: (a.task as { projectId?: string }).projectId ?? '',
                      })
                    : undefined);
            if (parentVersion) {
                liveAttachmentParentTasks.set(a.id, {
                    taskId: a.taskId,
                    version: parentVersion,
                });
            }
        }

        interface VerifiedMatchItem {
            match: typeof activeMatches[0];
            provenance: SourceProvenance[];
        }

        const verifiedFreshMatches: VerifiedMatchItem[] = [];
        let anyMatchIneligible = searchHits.matches.length !== activeMatches.length;

        for (const match of activeMatches) {
            const entityId = match.id.split("#")[0];
            const type = match.metadata?.type;
            const taskId = typeof match.metadata?.taskId === "string" ? match.metadata.taskId : undefined;
            const indexedVersion = typeof match.metadata?.sourceVersion === "string" ? match.metadata.sourceVersion : undefined;
            const indexedParentTaskVersion = typeof match.metadata?.parentTaskVersion === "string" ? match.metadata.parentTaskVersion : undefined;

            if (!indexedVersion) {
                // Missing, empty, or legacy version metadata -> ineligible
                anyMatchIneligible = true;
                continue;
            }

            if (type === "task") {
                const targetTaskId = taskId || entityId;
                const currentVersion = liveTaskVersions.get(targetTaskId);
                if (!currentVersion || currentVersion !== indexedVersion) {
                    // Stale or missing in DB -> ineligible
                    anyMatchIneligible = true;
                    continue;
                }
                verifiedFreshMatches.push({
                    match,
                    provenance: [{ type: "task", id: targetTaskId, version: currentVersion }],
                });
            } else if (type === "document") {
                const currentAttVersion = liveAttachmentVersions.get(entityId);
                const parentTaskInfo = liveAttachmentParentTasks.get(entityId);

                if (
                    !currentAttVersion ||
                    !parentTaskInfo ||
                    !indexedParentTaskVersion ||
                    indexedVersion !== currentAttVersion ||
                    indexedParentTaskVersion !== parentTaskInfo.version
                ) {
                    // Stale attachment or stale parent task -> ineligible
                    anyMatchIneligible = true;
                    continue;
                }

                verifiedFreshMatches.push({
                    match,
                    provenance: [
                        { type: "attachment", id: entityId, version: currentAttVersion },
                        { type: "task", id: parentTaskInfo.taskId, version: parentTaskInfo.version },
                    ],
                });
            } else {
                // Unknown source kind
                anyMatchIneligible = true;
            }
        }

        // 6. Assemble and Format the Context Block ONLY from verified fresh matches
        const compiledContextBlocks = verifiedFreshMatches
            .map((item, index) => {
                const hit = item.match;
                const textPayload = typeof hit.metadata?.text === "string" ? hit.metadata.text : undefined;
                if (!textPayload) return null;

                const taskId = hit.metadata?.taskId || "Unknown ID";
                const scorePercentage = Math.round(hit.score ? hit.score * 100 : 0);

                return `[Context Chunk #${index + 1} | Source Task ID: ${taskId} | Semantic Match: ${scorePercentage}%]\n${textPayload}`;
            })
            .filter(Boolean)
            .join("\n\n---\n\n");

        // 7. Structured Provenance
        const seenSources = new Set<string>();
        const provenance: SourceProvenance[] = [];
        for (const item of verifiedFreshMatches) {
            for (const src of item.provenance) {
                const key = `${src.type}:${src.id}`;
                if (!seenSources.has(key)) {
                    seenSources.add(key);
                    provenance.push(src);
                }
            }
        }

        const provenanceComplete =
            !anyMatchIneligible &&
            verifiedFreshMatches.length > 0 &&
            verifiedFreshMatches.length === searchHits.matches.length;

        return {
            context: compiledContextBlocks,
            provenance: collectProvenance ? provenance : [],
            provenanceComplete: collectProvenance ? provenanceComplete : false,
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
    precomputedEmbedding?: number[],
    topK: number = 5
): Promise<string> {
    const result = await runRetrieval(userQuery, orgId, precomputedEmbedding, false, topK);
    return result.context;
}

export async function retrieveRelevantContextWithProvenance(
    userQuery: string,
    orgId: string,
    precomputedEmbedding?: number[],
    topK: number = 5
): Promise<RetrievedContext> {
    return runRetrieval(userQuery, orgId, precomputedEmbedding, true, topK);
}
