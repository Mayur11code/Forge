import "server-only";
// src/app/api/worker/embedding-worker/ew.ts
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore } from "@/lib/vector/client";
import { buildSemanticPayload, extractPureText } from "@/lib/vector/text-extractor";
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
import { CredentialPurpose, type Task } from "@prisma/client";

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
  };
}

/**
 * Mask an identifier for secure, non-disclosing audit logging.
 */
function redactId(id: string): string {
  if (!id) return "[empty]";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

export async function embeddingWorkerHandler({ event }: EmbeddingEventParams): Promise<void> {
    try {
        const { entityId, orgId, type } = event.data;

        if (!entityId || !orgId) {
            console.error("❌ [EMBEDDING] Missing routing parameters", event.data);
            return;
        }

        // 1. TENANT-SCOPED RESOURCE VERIFICATION
        // CRITICAL: We must NOT delete vectors, extract content, generate embeddings,
        // or upsert until ownership within the event's orgId is strictly proven.
        let cleanText = "";
        let resolvedProjectId = "";
        let vectorEntityType: "task" | "document" = "task";
        let parentTaskId: string = entityId;

        if (type === "TASK") {
            // Tenant-scoped task query
            const task = await prisma.task.findFirst({
                where: {
                    id: entityId,
                    project: { orgId },
                },
                select: {
                    id: true,
                    title: true,
                    description: true,
                    status: true,
                    priority: true,
                    projectId: true,
                    assigneeId: true,
                },
            });

            if (!task) {
                // Determine whether this was a cross-tenant reference or deleted/nonexistent
                const unscopedTask = await prisma.task.findUnique({
                    where: { id: entityId },
                    select: { id: true, project: { select: { orgId: true } } },
                });

                if (unscopedTask) {
                    console.warn(
                        JSON.stringify({
                            securityEvent: "CROSS_TENANT_RESOURCE_REFERENCE_REJECTED",
                            subsystem: "embedding-worker",
                            resourceType: "TASK",
                            entityId: redactId(entityId),
                            eventOrgId: redactId(orgId),
                            actualOrgId: redactId(unscopedTask.project.orgId),
                            action: "REJECTED_WITHOUT_VECTOR_MUTATION",
                        }),
                    );
                    return;
                }

                console.log(`[EMBEDDING] Task ${entityId} deleted or not found. No operation.`);
                return;
            }

            cleanText = buildSemanticPayload(task as unknown as Task);
            resolvedProjectId = task.projectId || "";
            vectorEntityType = "task";
            parentTaskId = task.id;

        } else if (type === "ATTACHMENT") {
            // Tenant-scoped attachment query through task -> project -> orgId
            const attachment = await prisma.attachment.findFirst({
                where: {
                    id: entityId,
                    task: {
                        project: { orgId },
                    },
                },
                select: {
                    id: true,
                    name: true,
                    size: true,
                    taskId: true,
                    task: {
                        select: {
                            id: true,
                            title: true,
                            projectId: true,
                        },
                    },
                },
            });

            if (!attachment) {
                // Determine whether this was a cross-tenant reference or deleted/nonexistent
                const unscopedAttachment = await prisma.attachment.findUnique({
                    where: { id: entityId },
                    select: {
                        id: true,
                        task: {
                            select: {
                                project: { select: { orgId: true } },
                            },
                        },
                    },
                });

                if (unscopedAttachment) {
                    console.warn(
                        JSON.stringify({
                            securityEvent: "CROSS_TENANT_RESOURCE_REFERENCE_REJECTED",
                            subsystem: "embedding-worker",
                            resourceType: "ATTACHMENT",
                            entityId: redactId(entityId),
                            eventOrgId: redactId(orgId),
                            actualOrgId: redactId(unscopedAttachment.task?.project?.orgId ?? "unknown"),
                            action: "REJECTED_WITHOUT_VECTOR_MUTATION",
                        }),
                    );
                    return;
                }

                console.log(`[EMBEDDING] Attachment ${entityId} deleted or not found. No operation.`);
                return;
            }

            const cleanName = extractPureText(attachment.name);
            const cleanTaskTitle = extractPureText(attachment.task.title);
            const contextHeader = [
                `Entity Type: Attachment`,
                `Attachment ID: ${attachment.id}`,
                `Task ID: ${attachment.taskId}`,
                `Task Title: ${cleanTaskTitle}`,
                `Project ID: ${attachment.task.projectId}`,
                `File Name: ${cleanName}`,
                `File Size: ${attachment.size} bytes`,
            ].join("\n");

            cleanText = `${contextHeader}\n\nContent:\nAttachment: ${cleanName} on task ${cleanTaskTitle}`;
            resolvedProjectId = attachment.task.projectId || "";
            vectorEntityType = "document";
            parentTaskId = attachment.taskId;

        } else {
            console.warn(
                JSON.stringify({
                    securityEvent: "UNSUPPORTED_EMBEDDING_ENTITY_TYPE",
                    subsystem: "embedding-worker",
                    entityType: String(type),
                    entityId: redactId(entityId),
                    eventOrgId: redactId(orgId),
                    action: "REJECTED_WITHOUT_VECTOR_MUTATION",
                }),
            );
            return;
        }

        // 2. NOW THAT OWNERSHIP IS VERIFIED: Execute Wipe in Tenant Vector Store
        const vectorStore = getTenantVectorStore(orgId);
        console.log(`[EMBEDDING] Wiping old vectors for verified entity: ${entityId} in tenant: ${orgId}`);
        await vectorStore.deleteByTask(entityId);

        // 3. Chunk the text
        const chunks = await chunkTextSemantically(cleanText);

        if (chunks.length === 0) {
            console.log(`[EMBEDDING] Entity ${entityId} yielded an empty payload.`);
            return;
        }

        console.log(`[EMBEDDING] Slicing entity into ${chunks.length} semantic chunks.`);

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
        const embeddings = result.embeddings.map((e) => e.values);

        // 5. Rewrite to Pinecone
        const upsertPromises = chunks.map((chunkText, i) => {
            const deterministicId = `${entityId}#${i}`;

            return vectorStore.upsert(
                deterministicId,
                embeddings[i],
                {
                    text: chunkText,
                    taskId: parentTaskId,
                    projectId: resolvedProjectId,
                    type: vectorEntityType,
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
