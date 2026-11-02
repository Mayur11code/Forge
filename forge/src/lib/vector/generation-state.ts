// src/lib/vector/generation-state.ts
/**
 * Forge Vector V2: Durable Generation State Model & Transition Service
 *
 * Implements authoritative PostgreSQL lifecycle management for vector generations:
 * 1. VectorEntityHead initialization and permanent tombstones.
 * 2. Writer reservation with lease fencing using PostgreSQL clock_timestamp().
 * 3. Write receipt contract validation in markGenerationWritten.
 * 4. Atomic activation with strict lock ordering:
 *      Step 1: SELECT ... FOR UPDATE OF t/a on Task or Attachment (verifies existence, tenant, freshness)
 *      Step 2: SELECT ... FOR UPDATE on VectorEntityHead (verifies non-tombstoned, locks head)
 *      Step 3: SELECT ... FOR UPDATE on VectorGeneration (verifies status, ownership, lease)
 *      Step 4: Atomic generation status updates (OBSOLETE previous, ACTIVE replacement)
 * 5. Permanent deletion tombstones that survive relational business row cascades.
 * 6. Database-enforced constraints:
 *      - Partial unique index: at most one ACTIVE generation per head
 *      - Check constraint: tombstoned heads must have activeGenId = NULL
 *      - Check constraint: leased generations must have non-null claimToken
 *      - Foreign key: onDelete: Restrict on VectorGeneration.head to preserve permanent history
 */

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import {
  Prisma,
  VectorEntityHead,
  VectorGeneration,
  VectorEntityType,
  VectorGenerationStatus,
} from "@prisma/client";
import { taskSourceVersion, attachmentSourceVersion } from "./provenance";

// -----------------------------------------------------------------------------
// Custom Domain Errors
// -----------------------------------------------------------------------------

export class TombstonedEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TombstonedEntityError";
  }
}

export class StaleSourceVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSourceVersionError";
  }
}

export class LeaseExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseExpiredError";
  }
}

export class OwnershipTokenMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipTokenMismatchError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityNotFoundError";
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
  }
}

export class ConcurrentWriterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentWriterConflictError";
  }
}

export class ChunkCountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkCountMismatchError";
  }
}

export class ManifestDigestMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestDigestMismatchError";
  }
}

// -----------------------------------------------------------------------------
// Operation Interfaces & Write Receipt Contract
// -----------------------------------------------------------------------------

export interface GetOrCreateHeadInput {
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  tx?: Prisma.TransactionClient;
}

export interface ReserveGenerationInput {
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  sourceVersion: string;
  parentTaskVersion?: string;
  embeddingModelId: string;
  embeddingDimension: number;
  contractVersion: string;
  expectedChunkCount: number;
  manifestDigest?: string;
  leaseDurationSeconds?: number;
  tx?: Prisma.TransactionClient;
}

export interface ReserveGenerationResult {
  generation: VectorGeneration;
  claimToken: string;
  head: VectorEntityHead;
}

/**
 * Write Receipt Contract:
 * Returned by the external Pinecone writer upon successfully slicing, embedding,
 * and dispatching all chunk vectors to the vector database.
 */
export interface VectorWriteReceipt {
  /** Target generation ID */
  generationId: string;
  /** Writer claim token holding the active lease */
  claimToken: string;
  /** Exact count of vector chunks actually written */
  writtenChunkCount: number;
  /** Optional cryptographic digest of chunk IDs and payloads */
  manifestDigest?: string;
}

export interface MarkGenerationWrittenInput {
  receipt: VectorWriteReceipt;
  tx?: Prisma.TransactionClient;
}

export interface ActivateGenerationInput {
  headId: string;
  generationId: string;
  claimToken: string;
  expectedSourceVersion: string;
  expectedParentTaskVersion?: string;
  tx?: Prisma.TransactionClient;
}

export interface ActivateGenerationResult {
  head: VectorEntityHead;
  activatedGeneration: VectorGeneration;
  obsoletedGenerationId: string | null;
}

export interface TombstoneEntityHeadInput {
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  tx?: Prisma.TransactionClient;
}

// -----------------------------------------------------------------------------
// A. Head Initialization
// -----------------------------------------------------------------------------

/**
 * Retrieves or creates a VectorEntityHead using authoritative tenant and entity identity.
 * Concurrency-safe: uses upsert with empty update so an existing head is never overwritten
 * and an existing tombstone is NEVER resurrected or reset.
 */
export async function getOrCreateEntityHead({
  orgId,
  entityType,
  entityId,
  tx,
}: GetOrCreateHeadInput): Promise<VectorEntityHead> {
  const client = tx ?? db;

  return await client.vectorEntityHead.upsert({
    where: {
      orgId_entityType_entityId: {
        orgId,
        entityType,
        entityId,
      },
    },
    create: {
      orgId,
      entityType,
      entityId,
      isTombstone: false,
    },
    update: {}, // Invariant: never touches or resets isTombstone or activeGenId
  });
}

// -----------------------------------------------------------------------------
// B. Generation Reservation
// -----------------------------------------------------------------------------

/**
 * Creates a WRITING generation with a unique writer claim token and lease.
 * Fails closed if the entity is tombstoned.
 * Prevents duplicate active ownership during concurrent event deliveries.
 * Evaluates leases using PostgreSQL clock_timestamp().
 */
export async function reserveGeneration(
  input: ReserveGenerationInput
): Promise<ReserveGenerationResult> {
  const executeInTx = async (tx: Prisma.TransactionClient): Promise<ReserveGenerationResult> => {
    // 1. Get or create head
    const head = await getOrCreateEntityHead({
      orgId: input.orgId,
      entityType: input.entityType,
      entityId: input.entityId,
      tx,
    });

    // Invariant: Refuse work for tombstoned entities
    if (head.isTombstone) {
      throw new TombstonedEntityError(
        `Cannot reserve vector generation for tombstoned entity ${input.entityType}:${input.entityId} (org: ${input.orgId})`
      );
    }

    // 2. Check for concurrent live writers with unexpired leases
    const activeWriters = await tx.$queryRaw<Array<{ id: string; claimToken: string }>>`
      SELECT id, "claimToken" FROM "VectorGeneration"
      WHERE "headId" = ${head.id}
        AND status = 'WRITING'
        AND "leaseExpiresAt" > clock_timestamp()
    `;

    if (activeWriters.length > 0) {
      throw new ConcurrentWriterConflictError(
        `Active writer ${activeWriters[0].id} already holds a valid lease for ${input.entityType}:${input.entityId}`
      );
    }

    // 3. Create WRITING generation with unique claim token and generation ID
    const genId = `gen_${crypto.randomUUID()}`;
    const claimToken = `claim_${crypto.randomUUID()}`;
    const leaseDurationSeconds = input.leaseDurationSeconds ?? 300; // 5 min default

    await tx.$executeRaw`
      INSERT INTO "VectorGeneration" (
        id, "headId", "sourceVersion", "parentTaskVersion", "embeddingModelId",
        "embeddingDimension", "contractVersion", "expectedChunkCount", "manifestDigest",
        status, "claimToken", "leaseExpiresAt", "writeAttempts", "cleanupAttempts",
        "createdAt", "updatedAt"
      ) VALUES (
        ${genId},
        ${head.id},
        ${input.sourceVersion},
        ${input.parentTaskVersion ?? null},
        ${input.embeddingModelId},
        ${input.embeddingDimension},
        ${input.contractVersion},
        ${input.expectedChunkCount},
        ${input.manifestDigest ?? null},
        'WRITING'::"VectorGenerationStatus",
        ${claimToken},
        clock_timestamp() + make_interval(secs => ${leaseDurationSeconds}),
        1,
        0,
        clock_timestamp(),
        clock_timestamp()
      )
    `;

    const generation = await tx.vectorGeneration.findUniqueOrThrow({
      where: { id: genId },
    });

    return { generation, claimToken, head };
  };

  return input.tx
    ? await executeInTx(input.tx)
    : await db.$transaction(executeInTx);
}

// -----------------------------------------------------------------------------
// C. Mark Generation Written (Write Receipt Contract)
// -----------------------------------------------------------------------------

/**
 * Transitions a generation from WRITING to WRITTEN upon validating an external write receipt.
 *
 * Contract Guarantees:
 * 1. Generation status must be WRITING
 * 2. Supplied receipt.claimToken must match generation.claimToken
 * 3. Lease must be valid according to PostgreSQL clock_timestamp()
 * 4. receipt.writtenChunkCount must strictly equal generation.expectedChunkCount
 * 5. receipt.manifestDigest must match generation.manifestDigest (if defined)
 *
 * NOTE: This validates the application write contract between the worker and the state service.
 * Physical store read-back verification is deferred to Phase B / reconciliation.
 */
export async function markGenerationWritten({
  receipt,
  tx,
}: MarkGenerationWrittenInput): Promise<VectorGeneration> {
  const client = tx ?? db;

  if (receipt.writtenChunkCount < 0) {
    throw new Error("writtenChunkCount must be non-negative");
  }

  // 1. Lock and inspect generation row for strict contract validation
  const genRows = await client.$queryRaw<Array<{
    id: string;
    headId: string;
    status: string;
    claimToken: string | null;
    expectedChunkCount: number;
    manifestDigest: string | null;
    isLeaseValid: boolean;
  }>>`
    SELECT id, "headId", status::text, "claimToken", "expectedChunkCount", "manifestDigest",
           ("leaseExpiresAt" > clock_timestamp()) as "isLeaseValid"
    FROM "VectorGeneration"
    WHERE id = ${receipt.generationId}
    FOR UPDATE
  `;

  if (genRows.length === 0) {
    throw new EntityNotFoundError(`VectorGeneration ${receipt.generationId} not found`);
  }

  const gen = genRows[0];

  if (gen.status !== "WRITING") {
    throw new InvalidStateTransitionError(
      `Cannot mark generation written: status is '${gen.status}', expected 'WRITING'`
    );
  }

  if (gen.claimToken !== receipt.claimToken) {
    throw new OwnershipTokenMismatchError(
      `Claim token mismatch for generation ${receipt.generationId}`
    );
  }

  if (!gen.isLeaseValid) {
    throw new LeaseExpiredError(
      `Writer lease for generation ${receipt.generationId} expired before completion`
    );
  }

  // Contract Validation 1: Expected chunk count vs written count
  if (receipt.writtenChunkCount !== gen.expectedChunkCount) {
    throw new ChunkCountMismatchError(
      `Write receipt chunk count (${receipt.writtenChunkCount}) does not match expected chunk count (${gen.expectedChunkCount}) for generation ${receipt.generationId}`
    );
  }

  // Contract Validation 2: Manifest digest validation
  if (gen.manifestDigest && receipt.manifestDigest && gen.manifestDigest !== receipt.manifestDigest) {
    throw new ManifestDigestMismatchError(
      `Write receipt manifest digest does not match expected digest for generation ${receipt.generationId}`
    );
  }

  // 2. Transition status to WRITTEN
  await client.$executeRaw`
    UPDATE "VectorGeneration"
    SET status = 'WRITTEN'::"VectorGenerationStatus",
        "manifestDigest" = COALESCE(${receipt.manifestDigest ?? null}, "manifestDigest"),
        "updatedAt" = clock_timestamp()
    WHERE id = ${receipt.generationId}
      AND status = 'WRITING'
  `;

  return await client.vectorGeneration.findUniqueOrThrow({
    where: { id: receipt.generationId },
  });
}

// -----------------------------------------------------------------------------
// D. Generation Activation
// -----------------------------------------------------------------------------

/**
 * Atomically activates a WRITTEN generation in a single database transaction.
 *
 * Strict Lock Order:
 * 1. Lock authoritative business entity (Task or Attachment) via SELECT ... FOR UPDATE OF t/a.
 *    - Verifies entity exists and matches tenant scope.
 *    - Recomputes current authoritative sourceVersion.
 *    - Aborts if sourceVersion does not match expectedSourceVersion.
 * 2. Lock VectorEntityHead via SELECT ... FOR UPDATE.
 *    - Verifies isTombstone = false.
 * 3. Lock VectorGeneration via SELECT ... FOR UPDATE.
 *    - Verifies status = WRITTEN.
 *    - Verifies claimToken ownership and lease validity.
 * 4. Atomic Transition:
 *    - Mark previous active generation OBSOLETE.
 *    - Mark replacement generation ACTIVE (clearing lease and claimToken).
 *    - Update head.activeGenId to replacement generation.
 */
export async function activateGeneration({
  headId,
  generationId,
  claimToken,
  expectedSourceVersion,
  expectedParentTaskVersion,
  tx,
}: ActivateGenerationInput): Promise<ActivateGenerationResult> {
  const executeInTx = async (client: Prisma.TransactionClient): Promise<ActivateGenerationResult> => {
    // Read head metadata without lock first to identify entityType and entityId
    const headMeta = await client.vectorEntityHead.findUnique({
      where: { id: headId },
      select: { id: true, orgId: true, entityType: true, entityId: true },
    });

    if (!headMeta) {
      throw new EntityNotFoundError(`VectorEntityHead ${headId} not found`);
    }

    // -------------------------------------------------------------------------
    // STEP 1: Lock authoritative business entity and revalidate source freshness
    // -------------------------------------------------------------------------
    if (headMeta.entityType === "TASK") {
      const taskRows = await client.$queryRaw<
        Array<{ id: string; projectId: string; updatedAt: Date; orgId: string }>
      >`
        SELECT t.id, t."projectId", t."updatedAt", p."orgId"
        FROM "Task" t
        JOIN "Project" p ON t."projectId" = p.id
        WHERE t.id = ${headMeta.entityId}
        FOR UPDATE OF t
      `;

      if (taskRows.length === 0) {
        throw new EntityNotFoundError(
          `Authoritative Task ${headMeta.entityId} not found or deleted`
        );
      }

      const task = taskRows[0];
      if (task.orgId !== headMeta.orgId) {
        throw new Error(
          `Tenant scope mismatch: Task ${task.id} belongs to ${task.orgId}, expected ${headMeta.orgId}`
        );
      }

      const currentVersion = taskSourceVersion({
        updatedAt: task.updatedAt,
        projectId: task.projectId,
      });

      if (currentVersion !== expectedSourceVersion) {
        throw new StaleSourceVersionError(
          `Task source version changed during vector generation (current: ${currentVersion}, expected: ${expectedSourceVersion})`
        );
      }
    } else if (headMeta.entityType === "ATTACHMENT") {
      const attRows = await client.$queryRaw<
        Array<{
          id: string;
          taskId: string;
          createdAt: Date;
          size: number;
          taskUpdatedAt: Date;
          taskProjectId: string;
          orgId: string;
        }>
      >`
        SELECT a.id, a."taskId", a."createdAt", a.size,
               t."updatedAt" as "taskUpdatedAt", t."projectId" as "taskProjectId",
               p."orgId"
        FROM "Attachment" a
        JOIN "Task" t ON a."taskId" = t.id
        JOIN "Project" p ON t."projectId" = p.id
        WHERE a.id = ${headMeta.entityId}
        FOR UPDATE OF a
      `;

      if (attRows.length === 0) {
        throw new EntityNotFoundError(
          `Authoritative Attachment ${headMeta.entityId} not found or deleted`
        );
      }

      const att = attRows[0];
      if (att.orgId !== headMeta.orgId) {
        throw new Error(
          `Tenant scope mismatch: Attachment ${att.id} belongs to ${att.orgId}, expected ${headMeta.orgId}`
        );
      }

      const currentVersion = attachmentSourceVersion({
        taskId: att.taskId,
        createdAt: att.createdAt,
        size: att.size,
        task: { updatedAt: att.taskUpdatedAt },
      });

      if (currentVersion !== expectedSourceVersion) {
        throw new StaleSourceVersionError(
          `Attachment source version changed during vector generation (current: ${currentVersion}, expected: ${expectedSourceVersion})`
        );
      }

      if (expectedParentTaskVersion) {
        const currentParentVersion = taskSourceVersion({
          updatedAt: att.taskUpdatedAt,
          projectId: att.taskProjectId,
        });
        if (currentParentVersion !== expectedParentTaskVersion) {
          throw new StaleSourceVersionError(
            `Parent task version changed during attachment vector generation (current: ${currentParentVersion}, expected: ${expectedParentTaskVersion})`
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // STEP 2: Lock VectorEntityHead and verify not tombstoned
    // -------------------------------------------------------------------------
    const lockedHeads = await client.$queryRaw<
      Array<{ id: string; orgId: string; activeGenId: string | null; isTombstone: boolean }>
    >`
      SELECT id, "orgId", "activeGenId", "isTombstone"
      FROM "VectorEntityHead"
      WHERE id = ${headId}
      FOR UPDATE
    `;

    if (lockedHeads.length === 0) {
      throw new EntityNotFoundError(`VectorEntityHead ${headId} not found`);
    }

    const lockedHead = lockedHeads[0];
    if (lockedHead.isTombstone) {
      throw new TombstonedEntityError(
        `Cannot activate vector generation: VectorEntityHead ${headId} is tombstoned`
      );
    }

    // -------------------------------------------------------------------------
    // STEP 3: Lock VectorGeneration and verify status, ownership, and lease
    // -------------------------------------------------------------------------
    const genRows = await client.$queryRaw<
      Array<{
        id: string;
        headId: string;
        status: string;
        claimToken: string | null;
        sourceVersion: string;
        isLeaseValid: boolean;
      }>
    >`
      SELECT id, "headId", status::text, "claimToken", "sourceVersion",
             ("leaseExpiresAt" > clock_timestamp()) as "isLeaseValid"
      FROM "VectorGeneration"
      WHERE id = ${generationId}
      FOR UPDATE
    `;

    if (genRows.length === 0) {
      throw new EntityNotFoundError(`VectorGeneration ${generationId} not found`);
    }

    const targetGen = genRows[0];
    if (targetGen.headId !== headId) {
      throw new Error(
        `Integrity violation: Generation ${generationId} belongs to head ${targetGen.headId}, not ${headId}`
      );
    }
    if (targetGen.status !== "WRITTEN") {
      throw new InvalidStateTransitionError(
        `Cannot activate generation ${generationId}: status is '${targetGen.status}', expected 'WRITTEN'`
      );
    }
    if (targetGen.claimToken !== claimToken) {
      throw new OwnershipTokenMismatchError(
        `Claim token mismatch for generation ${generationId}`
      );
    }
    if (!targetGen.isLeaseValid) {
      throw new LeaseExpiredError(
        `Writer lease expired before activation for generation ${generationId}`
      );
    }
    if (targetGen.sourceVersion !== expectedSourceVersion) {
      throw new StaleSourceVersionError(
        `Generation sourceVersion (${targetGen.sourceVersion}) does not match expected (${expectedSourceVersion})`
      );
    }

    // -------------------------------------------------------------------------
    // STEP 4: Atomic Pointer and Status Transition
    // -------------------------------------------------------------------------
    const obsoletedGenId = lockedHead.activeGenId;

    // 4A. Obsolete previously active generation (if any and distinct)
    if (obsoletedGenId && obsoletedGenId !== generationId) {
      await client.$executeRaw`
        UPDATE "VectorGeneration"
        SET status = 'OBSOLETE'::"VectorGenerationStatus",
            "updatedAt" = clock_timestamp()
        WHERE id = ${obsoletedGenId}
          AND status = 'ACTIVE'
      `;
    }

    // 4B. Activate new generation (clearing lease and claim token)
    await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'ACTIVE'::"VectorGenerationStatus",
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = ${generationId}
        AND status = 'WRITTEN'
    `;

    // 4C. Update head pointer
    await client.$executeRaw`
      UPDATE "VectorEntityHead"
      SET "activeGenId" = ${generationId},
          "updatedAt" = clock_timestamp()
      WHERE id = ${headId}
    `;

    const updatedHead = await client.vectorEntityHead.findUniqueOrThrow({
      where: { id: headId },
    });
    const activatedGen = await client.vectorGeneration.findUniqueOrThrow({
      where: { id: generationId },
    });

    return {
      head: updatedHead,
      activatedGeneration: activatedGen,
      obsoletedGenerationId: obsoletedGenId,
    };
  };

  return tx ? await executeInTx(tx) : await db.$transaction(executeInTx);
}

// -----------------------------------------------------------------------------
// E. Tombstoning
// -----------------------------------------------------------------------------

/**
 * Transactionally creates or updates an entity head to permanent tombstone state.
 *
 * Guarantees:
 * 1. Creates head if non-existent with isTombstone = true, tombstonedAt = clock_timestamp().
 * 2. If head exists: sets isTombstone = true, tombstonedAt = clock_timestamp().
 * 3. Clears activeGenId pointer immediately (activeGenId = NULL).
 * 4. Obsoletes any formerly ACTIVE generation.
 * 5. Fails any in-progress WRITING or WRITTEN generations.
 * 6. Permanent and irreversible: cannot be cleared by worker initialization.
 * 7. Never mutates Pinecone vectors directly (deferred to outbox / sweeper).
 * 8. Pure persistence semantics: no mock-detection fallbacks.
 */
export async function tombstoneEntityHead({
  orgId,
  entityType,
  entityId,
  tx,
}: TombstoneEntityHeadInput): Promise<VectorEntityHead> {
  const client = tx ?? db;

  // 1. Atomically upsert head into permanent tombstone state using raw SQL with clock_timestamp()
  const randomHeadId = `head_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  await client.$executeRaw`
    INSERT INTO "VectorEntityHead" (
      id, "orgId", "entityType", "entityId", "isTombstone", "tombstonedAt",
      "activeGenId", "createdAt", "updatedAt"
    ) VALUES (
      ${randomHeadId},
      ${orgId},
      ${entityType}::"VectorEntityType",
      ${entityId},
      true,
      clock_timestamp(),
      NULL,
      clock_timestamp(),
      clock_timestamp()
    )
    ON CONFLICT ("orgId", "entityType", "entityId")
    DO UPDATE SET
      "isTombstone" = true,
      "tombstonedAt" = COALESCE("VectorEntityHead"."tombstonedAt", clock_timestamp()),
      "activeGenId" = NULL,
      "updatedAt" = clock_timestamp()
  `;

  // 2. Fetch the authoritative head record
  const head = await client.vectorEntityHead.findUniqueOrThrow({
    where: {
      orgId_entityType_entityId: {
        orgId,
        entityType,
        entityId,
      },
    },
  });

  // 3. Obsolete any formerly ACTIVE generation
  await client.$executeRaw`
    UPDATE "VectorGeneration"
    SET status = 'OBSOLETE'::"VectorGenerationStatus",
        "updatedAt" = clock_timestamp()
    WHERE "headId" = ${head.id}
      AND status = 'ACTIVE'
  `;

  // 4. Fail any in-flight WRITING or WRITTEN generations
  await client.$executeRaw`
    UPDATE "VectorGeneration"
    SET status = 'FAILED'::"VectorGenerationStatus",
        "lastError" = 'Entity tombstoned before activation',
        "claimToken" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = clock_timestamp()
    WHERE "headId" = ${head.id}
      AND status IN ('WRITING', 'WRITTEN')
  `;

  return head;
}
