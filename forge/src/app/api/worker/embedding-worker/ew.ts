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

export interface EmbeddingWorkerOptions {
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
}

export interface EmbeddingEventParams {
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
  options?: EmbeddingWorkerOptions;
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
export async function embeddingWorkerHandler({ event, options }: EmbeddingEventParams): Promise<void> {
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
      const entityHeadDelegate = (db as unknown as {
        vectorEntityHead?: {
          findFirst: (args: {
            where: { orgId: string; entityType: VectorEntityType; entityId: string };
            select: { activeGenId: boolean };
          }) => Promise<{ activeGenId: string | null } | null>;
        };
      }).vectorEntityHead;
      if (typeof entityHeadDelegate?.findFirst === "function") {
        const existingHead = await entityHeadDelegate.findFirst({
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

  const leaseSeconds = options?.leaseDurationSeconds ?? 300;
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ??
    Math.min(30_000, Math.max(100, Math.floor((leaseSeconds * 1000) / 3)));

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
    leaseDurationSeconds: leaseSeconds,
  });

  let genHeartbeatTimer: NodeJS.Timeout | null = null;
  let genOwnershipLost = false;
  let genHeartbeatActive = true;
  let genRenewalInFlight = false;
  let genRenewalPromise: Promise<void> | null = null;

  const { renewGenerationLease } = await import("@/lib/vector/generation-state");

  const stopGenHeartbeat = () => {
    genHeartbeatActive = false;
    if (genHeartbeatTimer) {
      clearInterval(genHeartbeatTimer);
      genHeartbeatTimer = null;
    }
  };

  const performGenRenewal = async () => {
    if (!genHeartbeatActive || genOwnershipLost || genRenewalInFlight) return;
    genRenewalInFlight = true;
    const currentPromise = (async () => {
      try {
        await renewGenerationLease({
          generationId: generation.id,
          claimToken,
          extensionSeconds: leaseSeconds,
        });
      } catch {
        genOwnershipLost = true;
        stopGenHeartbeat();
      } finally {
        genRenewalInFlight = false;
        genRenewalPromise = null;
      }
    })();
    genRenewalPromise = currentPromise;
    await currentPromise;
  };

  // Start continuous recurring renewal (Part 2 Area B1)
  genHeartbeatTimer = setInterval(() => {
    performGenRenewal().catch(() => {
      genOwnershipLost = true;
      stopGenHeartbeat();
    });
  }, heartbeatIntervalMs);
  if (typeof genHeartbeatTimer?.unref === "function") {
    genHeartbeatTimer.unref();
  }

  try {
    // 4. Batch Embeddings via Gemini (with multi-batch boundary fencing)
    const resolvedAi = await resolveOrganizationGenerativeAiClient({
      orgId,
      purpose: CredentialPurpose.EMBEDDING,
    });
    const activePrimary = resolvedAi.client.getGenerativeModel({ model: "gemini-embedding-001" });
    const fallbackModel = resolvedAi.fallbackClient
      ? resolvedAi.fallbackClient.getGenerativeModel({ model: "gemini-embedding-001" })
      : null;

    const GEMINI_MAX_BATCH_SIZE = 100;
    const chunkBatches: string[][] = [];
    for (let i = 0; i < chunks.length; i += GEMINI_MAX_BATCH_SIZE) {
      chunkBatches.push(chunks.slice(i, i + GEMINI_MAX_BATCH_SIZE));
    }

    const embeddings: number[][] = [];
    for (let b = 0; b < chunkBatches.length; b++) {
      // Boundary check before each subsequent Gemini embedding batch (B2)
      if (genOwnershipLost) {
        throw new Error(
          `Generation lease ownership lost before embedding batch ${b + 1}/${chunkBatches.length} for ${generation.id}`
        );
      }

      const batchRequests: EmbedContentRequest[] = chunkBatches[b].map((chunkText) => ({
        content: {
          role: "user",
          parts: [{ text: chunkText }],
        },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
        outputDimensionality: 768,
      }));

      let batchResult;
      try {
        batchResult = await activePrimary.batchEmbedContents({ requests: batchRequests });
      } catch (err) {
        if (fallbackModel && isGeminiAuthenticationError(err)) {
          // Check ownership immediately before dispatching fallback Gemini request (Issue 2)
          if (genOwnershipLost) {
            throw new Error(
              `Generation lease ownership lost before fallback embedding dispatch for ${generation.id}`
            );
          }
          logCredentialFailover({
            provider: "gemini",
            subsystem: "embedding-worker",
            slot: "primary",
            operation: "batchEmbedContents",
            errorCategory: "AUTH_FAILURE_FAILOVER",
            message: err instanceof Error ? err.message : String(err),
          });
          batchResult = await fallbackModel.batchEmbedContents({ requests: batchRequests });
        } else {
          throw err;
        }
      }

      for (const e of batchResult.embeddings) {
        embeddings.push(e.values);
      }
    }

    // Boundary check 2: Before Pinecone vector upsert (B2)
    if (genOwnershipLost) {
      throw new Error(`Generation lease ownership lost before Pinecone upsert for ${generation.id}`);
    }

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

    // Boundary check 3: Before write receipt (B2)
    if (genOwnershipLost) {
      throw new Error(`Generation lease ownership lost before write receipt for ${generation.id}`);
    }

    // 6. Write Receipt
    await markGenerationWritten({
      receipt: {
        generationId: generation.id,
        claimToken,
        writtenChunkCount: chunks.length,
        manifestDigest,
      },
    });

    // Boundary check 4: Before physical read-back verification (B2)
    if (genOwnershipLost) {
      throw new Error(`Generation lease ownership lost before physical verification for ${generation.id}`);
    }

    // 7. Bounded Physical Read-Back Verification (5,000ms strict monotonic verification deadline)
    const verification = await verifyPhysicalPersistence({
      orgId,
      generationId: generation.id,
      entityType: schemaEntityType,
      entityId,
      sourceRevision: expectedRevision,
      expectedChunkCount: chunks.length,
      expectedManifestDigest: manifestDigest,
      maxBudgetMs: 5000,
      fetcher: (ids) => vectorStore.fetchGenerationVectors(ids),
    });

    if (!verification.verified) {
      const failReason = `Physical persistence verification failed: ${verification.reason}`;
      console.error(`❌ [EMBEDDING] ${failReason}`);
      if (!genOwnershipLost) {
        await failGeneration({
          generationId: generation.id,
          claimToken,
          errorMessage: failReason,
        });
      }
      throw new Error(failReason);
    }

    // Boundary check 5: Release heartbeat timer before activation boundary (B2 & Part 2.1)
    stopGenHeartbeat();
    if (genRenewalPromise) {
      try {
        await genRenewalPromise;
      } catch {
        // Renewal failure already flagged genOwnershipLost
      }
    }

    if (genOwnershipLost) {
      throw new Error(`Generation lease ownership lost before activation for ${generation.id}`);
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
            if (!genOwnershipLost) {
              await failGeneration({
                generationId: generation.id,
                claimToken,
                errorMessage: "Entity tombstoned before activation",
                tx,
              });
            }
            return;
          }

          if (headRows.length > 0 && incomingRevision !== undefined && headRows[0].latestRevision > incomingRevision) {
            console.log(
              `[EMBEDDING] Generation superseded by newer mutation (head=${headRows[0].latestRevision}, gen=${incomingRevision}). Skipping activation.`
            );
            if (!genOwnershipLost) {
              await failGeneration({
                generationId: generation.id,
                claimToken,
                errorMessage: "Superseded by newer revision",
                tx,
              });
            }
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
          db: db as unknown as Parameters<typeof completeVectorOutboxEvent>[0]["db"],
          outboxEventId,
        });
      }
    }

    console.log(`✅ [EMBEDDING] Successfully activated generation ${generation.id} for ${schemaEntityType}:${entityId}`);

    const extendedPrisma = prisma as unknown as {
      attachment?: {
        findMany: (args: {
          where: { taskId: string; task: { project: { orgId: string } } };
          select: { id: boolean };
        }) => Promise<Array<{ id: string }>>;
      };
    };
    if (type === "TASK" && typeof extendedPrisma.attachment?.findMany === "function") {
      try {
        const childAttachments = await extendedPrisma.attachment.findMany({
          where: {
            taskId: entityId,
            task: { project: { orgId } },
          },
          select: { id: true },
        });

        if (childAttachments && childAttachments.length > 0) {
          const { publishEvent } = await import("@/lib/events/queue");
          await Promise.allSettled(
            childAttachments.map((att: { id: string }) =>
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
      if (!genOwnershipLost) {
        await failGeneration({
          generationId: generation.id,
          claimToken,
          errorMessage: workerErr instanceof Error ? workerErr.message : "Pipeline error",
        });
      }
    } catch {
      // Best-effort cleanup
    }
    throw workerErr;
  } finally {
    // Cleanup heartbeat timer on every exit path (B3)
    stopGenHeartbeat();
  }
}
