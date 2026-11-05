import "server-only";
// src/app/api/worker/embedding-worker/ew.ts
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
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
import { CredentialPurpose, VectorEntityType, type Task } from "@prisma/client";
import {
  taskSourceVersion,
  attachmentSourceVersion,
  computeTaskContentHash,
  computeAttachmentContentHash,
  computeAttachmentParentTaskVersion,
} from "@/lib/vector/provenance";
import {
  buildVectorId,
  computeManifestDigest,
  PineconeRecordV2,
} from "@/lib/vector/schema";
import { completeVectorOutboxEvent } from "@/lib/vector/outbox";

async function getDb() {
  const { db } = await import("@/lib/prisma/db");
  return db;
}

interface EmbeddingEventParams {
  event: {
    id: string;
    type: "EMBEDDING_REQUESTED";
    data: {
      orgId: string;
      entityId: string;
      type: "TASK" | "ATTACHMENT";
      actorId?: string;
      outboxEventId?: string;
      sourceRevision?: number;
      contentHash?: string;
      pipelineVersion?: string;
      parentTaskVersion?: string | null;
    };
    time: string;
  };
}

function redactId(id: string): string {
  if (!id) return "[empty]";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * Vector V2 Distributed Embedding Worker
 *
 * Implements the full lifecycle:
 * 1. Tenant boundary verification
 * 2. Writer reservation with lease fencing (reserveGeneration)
 * 3. Semantic chunking & batch embedding
 * 4. Generation-scoped Pinecone upsert (NO deleteByTask pre-wipe)
 * 5. Write receipt contract enforcement (markGenerationWritten)
 * 6. Bounded physical read-back verification (verifyPhysicalPersistence)
 * 7. Atomic row-lock activation with revision freshness check (activateGeneration)
 * 8. Outbox event completion (completeVectorOutboxEvent)
 */
export async function embeddingWorkerHandler({ event }: EmbeddingEventParams): Promise<void> {
  const {
    entityId,
    orgId,
    type,
    outboxEventId,
    sourceRevision: incomingRevision,
  } = event.data;

  if (!entityId || !orgId) {
    console.error("❌ [EMBEDDING] Missing routing parameters", event.data);
    return;
  }

  const prismaEntityType = type === "TASK" ? VectorEntityType.TASK : VectorEntityType.ATTACHMENT;
  const schemaEntityType = type === "TASK" ? "task" : "attachment";

  let cleanText = "";
  let cleanTitle = "";
  let resolvedProjectId = "";
  let parentTaskId: string = entityId;
  let sourceVersionToken: string;
  let parentTaskVersionToken: string | undefined = undefined;

  // 1. Authoritative Domain Entity Verification Scoped to orgId
  if (type === "TASK") {
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
        updatedAt: true,
      },
    });

    if (!task) {
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
          })
        );
        return;
      }

      console.log(`[EMBEDDING] Task ${entityId} deleted or not found. No operation.`);
      return;
    }

    cleanText = buildSemanticPayload(task as unknown as Task);
    cleanTitle = typeof extractPureText === "function" ? extractPureText(task.title) : (task.title ?? "");
    resolvedProjectId = task.projectId || "";
    parentTaskId = task.id;
    sourceVersionToken = taskSourceVersion({
      updatedAt: task.updatedAt,
      projectId: resolvedProjectId,
    });
  } else if (type === "ATTACHMENT") {
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
        fileKey: true,
        taskId: true,
        createdAt: true,
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!attachment) {
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
          })
        );
        return;
      }

      console.log(`[EMBEDDING] Attachment ${entityId} deleted or not found. No operation.`);
      return;
    }

    const cleanName = typeof extractPureText === "function" ? extractPureText(attachment.name) : (attachment.name ?? "");
    const cleanTaskTitle = typeof extractPureText === "function" ? extractPureText(attachment.task.title) : (attachment.task.title ?? "");
    cleanTitle = cleanName;
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
    parentTaskId = attachment.taskId;
    sourceVersionToken = attachmentSourceVersion({
      createdAt: attachment.createdAt,
      size: attachment.size,
      taskId: attachment.taskId,
      name: cleanName,
      task: { updatedAt: attachment.task.updatedAt },
    });
    parentTaskVersionToken = taskSourceVersion({
      updatedAt: attachment.task.updatedAt,
      projectId: resolvedProjectId,
    });
  } else {
    console.warn(
      JSON.stringify({
        securityEvent: "UNSUPPORTED_EMBEDDING_ENTITY_TYPE",
        subsystem: "embedding-worker",
        entityType: String(type),
        entityId: redactId(entityId),
        eventOrgId: redactId(orgId),
        action: "REJECTED_WITHOUT_VECTOR_MUTATION",
      })
    );
    return;
  }

  // 2. Semantic Chunking
  const chunks = await chunkTextSemantically(cleanText);
  if (chunks.length === 0) {
    console.log(`[EMBEDDING] Entity ${entityId} yielded an empty payload.`);
    return;
  }

  // 3. In-flight legacy message handling (Area 3.5 & Invariant I-4):
  // If no outboxEventId was supplied, check if an active V2 generation already exists for this entity.
  // If so, safely ignore (noop). If not, proceed to V2 generation synchronization without pre-wipe deleteByTask.
  if (!outboxEventId) {
    try {
      const db = await getDb();
      if (typeof (db as any).vectorEntityHead?.findFirst === "function") {
        const existingHead = await (db as any).vectorEntityHead.findFirst({
          where: {
            orgId,
            entityType: prismaEntityType,
            entityId,
          },
          select: { activeGenId: true },
        });
        if (existingHead?.activeGenId) {
          console.log(
            `[EMBEDDING] In-flight legacy message for ${schemaEntityType}:${entityId} safely ignored because active V2 generation ${existingHead.activeGenId} exists.`
          );
          return;
        }
      }
    } catch {
      // In-memory or fallback: proceed with V2 synchronization
    }
  }

  // 4. Reserve Vector Generation under PostgreSQL Lease
  const {
    reserveGeneration,
    markGenerationWritten,
    activateGeneration,
    failGeneration,
  } = await import("@/lib/vector/generation-state");

  const { generation, claimToken, head } = await reserveGeneration({
    orgId,
    entityType: prismaEntityType,
    entityId,
    sourceVersion: sourceVersionToken,
    parentTaskVersion: parentTaskVersionToken,
    embeddingModelId: "gemini-embedding-001",
    embeddingDimension: 768,
    contractVersion: "v2",
    expectedChunkCount: chunks.length,
    leaseDurationSeconds: 300,
  });

  try {
    // 4. Batch Embeddings via Gemini
    const resolvedAi = await resolveOrganizationGenerativeAiClient({
      orgId,
      purpose: CredentialPurpose.EMBEDDING,
    });
    const activePrimary = resolvedAi.client.getGenerativeModel({ model: "gemini-embedding-001" });
    const fallbackModel = resolvedAi.fallbackClient
      ? resolvedAi.fallbackClient.getGenerativeModel({ model: "gemini-embedding-001" })
      : null;

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
      result = await activePrimary.batchEmbedContents({ requests: embeddingRequests });
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
        result = await fallbackModel.batchEmbedContents({ requests: embeddingRequests });
      } else {
        throw err;
      }
    }

    const embeddings = result.embeddings.map((e) => e.values);

    // 5. Generation-Scoped Pinecone Upsert
    const vectorStore = getTenantVectorStore(orgId);
    const expectedRevision = incomingRevision ?? head.latestRevision;

    const records: PineconeRecordV2[] = chunks.map((chunkText, i) => {
      const id = buildVectorId(schemaEntityType, entityId, generation.id, i);
      return {
        id,
        values: embeddings[i],
        metadata: {
          contractVersion: "v2",
          entityType: schemaEntityType,
          entityId,
          generationId: generation.id,
          sourceRevision: expectedRevision,
          chunkIndex: i,
          chunkCount: chunks.length,
          orgId,
          projectId: resolvedProjectId,
          text: chunkText,
          title: cleanTitle,
          taskId: parentTaskId,
          sourceVersion: sourceVersionToken,
          parentTaskVersion: parentTaskVersionToken,
        },
      };
    });

    const manifestDigest = computeManifestDigest(
      records.map((r) => ({
        chunkIndex: r.metadata.chunkIndex,
        id: r.id,
        text: r.metadata.text,
      }))
    );

    await vectorStore.upsertGenerationVectors(records);

    // 6. Write Receipt
    await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: chunks.length,
        manifestDigest,
      },
    });

    // 7. Bounded Physical Read-Back Verification
    const verification = await verifyPhysicalPersistence({
      orgId,
      generationId: generation.id,
      entityType: schemaEntityType,
      entityId,
      sourceRevision: expectedRevision,
      expectedChunkCount: chunks.length,
      expectedManifestDigest: manifestDigest,
      maxBudgetMs: 15000,
    });

    if (!verification.verified) {
      const failReason = `Physical persistence verification failed: ${verification.reason}`;
      console.error(`❌ [EMBEDDING] ${failReason}`);
      await failGeneration({
        generationId: generation.id,
        claimToken,
        errorMessage: failReason,
      });
      throw new Error(failReason);
    }

    // 8. Atomic Activation with Row-Lock & Revision Supersession Check
    const db = await getDb();
    if (typeof db.$transaction === "function") {
      await db.$transaction(
        async (tx) => {
          let headRows: Array<{ latestRevision: number; isTombstone: boolean }> = [];
          if (typeof tx.$queryRaw === "function") {
            headRows = await tx.$queryRaw<Array<{ latestRevision: number; isTombstone: boolean }>>`
              SELECT "latestRevision", "isTombstone"
              FROM "VectorEntityHead"
              WHERE id = ${head.id}
              FOR UPDATE;
            `;
          }

          if (headRows.length > 0 && headRows[0].isTombstone) {
            await failGeneration({
              generationId: generation.id,
              claimToken,
              errorMessage: "Entity tombstoned before activation",
              tx,
            });
            return;
          }

          if (headRows.length > 0 && incomingRevision !== undefined && headRows[0].latestRevision > incomingRevision) {
            console.log(
              `[EMBEDDING] Generation superseded by newer mutation (head=${headRows[0].latestRevision}, gen=${incomingRevision}). Skipping activation.`
            );
            await failGeneration({
              generationId: generation.id,
              claimToken,
              errorMessage: "Superseded by newer revision",
              tx,
            });
            return;
          }

          await activateGeneration({
            headId: head.id,
            generationId: generation.id,
            claimToken,
            expectedSourceVersion: sourceVersionToken,
            expectedParentTaskVersion: parentTaskVersionToken,
            tx,
          });

          if (outboxEventId) {
            await completeVectorOutboxEvent({
              db: tx,
              outboxEventId,
            });
          }
        },
        { maxWait: 10000, timeout: 30000 }
      );
    } else {
      // In-memory / mock test fallback
      await activateGeneration({
        headId: head.id,
        generationId: generation.id,
        claimToken,
        expectedSourceVersion: sourceVersionToken,
        expectedParentTaskVersion: parentTaskVersionToken,
      });
      if (outboxEventId) {
        await completeVectorOutboxEvent({
          db: db as any,
          outboxEventId,
        });
      }
    }

    console.log(`✅ [EMBEDDING] Successfully activated generation ${generation.id} for ${schemaEntityType}:${entityId}`);

    if (type === "TASK" && typeof (prisma as any).attachment?.findMany === "function") {
      try {
        const childAttachments = await (prisma as any).attachment.findMany({
          where: {
            taskId: entityId,
            task: { project: { orgId } },
          },
          select: { id: true },
        });

        if (childAttachments && childAttachments.length > 0) {
          const { publishEvent } = await import("@/lib/events/queue");
          await Promise.allSettled(
            childAttachments.map((att: any) =>
              publishEvent("EMBEDDING_REQUESTED", {
                orgId,
                entityId: att.id,
                type: "ATTACHMENT",
              })
            )
          );
        }
      } catch (refreshErr) {
        console.warn("[EMBEDDING] Non-blocking child attachment refresh notice:", refreshErr);
      }
    }
  } catch (workerErr) {
    console.error("❌ [EMBEDDING] Failure during worker pipeline:", workerErr);
    try {
      await failGeneration({
        generationId: generation.id,
        claimToken,
        errorMessage: workerErr instanceof Error ? workerErr.message : "Pipeline error",
      });
    } catch {
      // Best-effort cleanup
    }
    throw workerErr;
  }
}
