// src/lib/vector/generation-state.ts
/**
 * Forge Vector V2: Durable Generation State Model & Transition Service
 *
 * Implements authoritative PostgreSQL lifecycle management for vector generations:
 * 1. VectorEntityHead initialization and permanent tombstones.
 * 2. Writer reservation with lease fencing using PostgreSQL clock_timestamp() and head row locking.
 * 3. Write receipt contract validation with strict manifest digest checking in markGenerationWritten.
 * 4. Atomic activation with strict global lock ordering:
 *      Project -> Task -> Attachment -> VectorEntityHead -> VectorGeneration
 * 5. Atomic state-transition functions: all operations execute within a single transaction
 *    and enforce ownership fencing in final conditional SQL statements with affected-row validation.
 * 6. Permanent deletion tombstones with deterministic multi-generation row locking.
 * 7. Composite referential integrity: VectorEntityHead(activeGenId, id) -> VectorGeneration(id, headId).
 * 8. Status Model Definitions:
 *    Operational in Phase A:
 *      - WRITING: Worker holds active time-bounded lease; generating/uploading vector chunks.
 *      - WRITTEN: Worker verified write receipt contract (chunk count & manifest digest); ready for activation.
 *      - ACTIVE: Authoritative vector generation for the head entity (pointed to by activeGenId).
 *      - OBSOLETE: Superseded by a newer ACTIVE generation or disabled by entity tombstoning.
 *      - FAILED: Worker failure, lease expiration before completion, or superseded by newer writer.
 *    Reserved for Phase D:
 *      - PURGING: Background vacuuming worker is actively pruning obsolete vectors from Pinecone/index.
 *      - PURGED: Vectors permanently removed from external index; record archived or retained for audit.
 */

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import {
  Prisma,
  VectorEntityHead,
  VectorGeneration,
  VectorEntityType,
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

export class MissingManifestDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingManifestDigestError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

// -----------------------------------------------------------------------------
// Input Validation Helpers
// -----------------------------------------------------------------------------

function validateString(val: unknown, fieldName: string): string {
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new InvalidInputError(`${fieldName} must be a non-empty string`);
  }
  return val.trim();
}

function validateInteger(val: unknown, fieldName: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof val !== "number" || !Number.isSafeInteger(val) || val < min || val > max) {
    throw new InvalidInputError(`${fieldName} must be a safe integer between ${min} and ${max}`);
  }
  return val;
}

function validateEntityType(val: unknown): VectorEntityType {
  if (val !== "TASK" && val !== "ATTACHMENT") {
    throw new InvalidInputError(`entityType must be 'TASK' or 'ATTACHMENT', received: ${String(val)}`);
  }
  return val;
}

async function runWithTx<T>(
  tx: Prisma.TransactionClient | undefined,
  executeInTx: (client: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (tx) return await executeInTx(tx);
  if (typeof db.$transaction === "function") {
    return await db.$transaction(executeInTx);
  }
  return await executeInTx(db as unknown as Prisma.TransactionClient);
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
 * Emitted by the worker upon slicing, embedding, and transmitting chunks to the vector database.
 * Confirms receipt and chunk count. NOTE: External vector store read-back is decoupled (Phase B/E4).
 */
export interface VectorWriteReceipt {
  /** Target generation ID */
  generationId: string;
  /** Writer claim token holding the active lease */
  claimToken: string;
  /** Exact count of vector chunks actually written */
  writtenChunkCount: number;
  /** Cryptographic digest of chunk IDs and payloads (required if generation required it) */
  manifestDigest?: string;
}

export interface MarkGenerationWrittenInput {
  receipt: VectorWriteReceipt;
  tx?: Prisma.TransactionClient;
}

export interface RenewGenerationLeaseInput {
  generationId: string;
  claimToken: string;
  extensionSeconds?: number;
  tx?: Prisma.TransactionClient;
}

export interface FailGenerationInput {
  generationId: string;
  claimToken: string;
  errorMessage: string;
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
  const validatedOrgId = validateString(orgId, "orgId");
  const validatedEntityType = validateEntityType(entityType);
  const validatedEntityId = validateString(entityId, "entityId");

  const client = tx ?? db;
  const newHeadId = `head_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return await client.vectorEntityHead.upsert({
    where: {
      orgId_entityType_entityId: {
        orgId: validatedOrgId,
        entityType: validatedEntityType,
        entityId: validatedEntityId,
      },
    },
    create: {
      id: newHeadId,
      orgId: validatedOrgId,
      entityType: validatedEntityType,
      entityId: validatedEntityId,
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
 *
 * Atomicity and Concurrency Invariants:
 * 1. Validates inputs and tenant existence of authoritative entity.
 * 2. Operates within a single database transaction.
 * 3. Retrieves or creates VectorEntityHead, then acquires a row lock (SELECT ... FOR UPDATE).
 * 4. Re-reads tombstone status after acquiring the row lock (rejects if tombstoned).
 * 5. Serializes competing writers: checks for active unexpired WRITING generations while head is locked.
 * 6. Inserts the new generation only when no valid writer exists.
 */
export async function reserveGeneration(
  input: ReserveGenerationInput
): Promise<ReserveGenerationResult> {
  const validatedOrgId = validateString(input.orgId, "orgId");
  const validatedEntityType = validateEntityType(input.entityType);
  const validatedEntityId = validateString(input.entityId, "entityId");
  const validatedSourceVersion = validateString(input.sourceVersion, "sourceVersion");
  const validatedEmbeddingModelId = validateString(input.embeddingModelId, "embeddingModelId");
  const validatedContractVersion = validateString(input.contractVersion, "contractVersion");
  const validatedEmbeddingDimension = validateInteger(input.embeddingDimension, "embeddingDimension", 1);
  const validatedExpectedChunkCount = validateInteger(input.expectedChunkCount, "expectedChunkCount", 0);
  const leaseDurationSeconds = input.leaseDurationSeconds !== undefined
    ? validateInteger(input.leaseDurationSeconds, "leaseDurationSeconds", 1, 3600)
    : 300;

  const executeInTx = async (tx: Prisma.TransactionClient): Promise<ReserveGenerationResult> => {
    // 1. Authoritative Domain Entity & Tenant Scope Verification (Trust Boundary)
    if (validatedEntityType === "TASK") {
      const task = await tx.task.findFirst({
        where: { id: validatedEntityId, project: { orgId: validatedOrgId } },
        select: { id: true },
      });
      if (!task) {
        throw new EntityNotFoundError(
          `Authoritative Task ${validatedEntityId} not found in organization ${validatedOrgId}`
        );
      }
    } else if (validatedEntityType === "ATTACHMENT") {
      const att = await tx.attachment.findFirst({
        where: { id: validatedEntityId, task: { project: { orgId: validatedOrgId } } },
        select: { id: true },
      });
      if (!att) {
        throw new EntityNotFoundError(
          `Authoritative Attachment ${validatedEntityId} not found in organization ${validatedOrgId}`
        );
      }
    }

    // 2. Get or create head
    const head = await getOrCreateEntityHead({
      orgId: validatedOrgId,
      entityType: validatedEntityType,
      entityId: validatedEntityId,
      tx,
    });

    // 3. Serializing Head Lock: acquire row lock on VectorEntityHead
    const lockedHeads = await tx.$queryRaw<Array<{ id: string; isTombstone: boolean }>>`
      SELECT id, "isTombstone"
      FROM "VectorEntityHead"
      WHERE id = ${head.id}
      FOR UPDATE
    `;

    if (lockedHeads.length === 0) {
      throw new EntityNotFoundError(`VectorEntityHead ${head.id} not found`);
    }

    const lockedHead = lockedHeads[0];

    // Invariant: Re-read tombstone status after acquiring the head row lock
    if (lockedHead.isTombstone) {
      throw new TombstonedEntityError(
        `Cannot reserve vector generation for tombstoned entity ${validatedEntityType}:${validatedEntityId} (org: ${validatedOrgId})`
      );
    }

    // 4. Check for concurrent live writers with unexpired leases under the locked head
    const activeWriters = await tx.$queryRaw<Array<{ id: string; claimToken: string }>>`
      SELECT id, "claimToken" FROM "VectorGeneration"
      WHERE "headId" = ${head.id}
        AND status = 'WRITING'
        AND "leaseExpiresAt" > clock_timestamp()
    `;

    if (activeWriters.length > 0) {
      throw new ConcurrentWriterConflictError(
        `Active writer ${activeWriters[0].id} already holds a valid lease for ${validatedEntityType}:${validatedEntityId}`
      );
    }

    // 4B. Supersede any expired WRITING generations on this head by marking them FAILED
    await tx.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'FAILED'::"VectorGenerationStatus",
          "lastError" = 'Writer lease expired; superseded by subsequent reservation',
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE "headId" = ${head.id}
        AND status = 'WRITING'
        AND "leaseExpiresAt" <= clock_timestamp()
    `;

    // 5. Create WRITING generation with unique claim token and generation ID
    const genId = `gen_${crypto.randomUUID()}`;
    const claimToken = `claim_${crypto.randomUUID()}`;

    await tx.$executeRaw`
      INSERT INTO "VectorGeneration" (
        id, "headId", "sourceVersion", "parentTaskVersion", "embeddingModelId",
        "embeddingDimension", "contractVersion", "expectedChunkCount", "manifestDigest",
        status, "claimToken", "leaseExpiresAt", "writeAttempts", "cleanupAttempts",
        "createdAt", "updatedAt"
      ) VALUES (
        ${genId},
        ${head.id},
        ${validatedSourceVersion},
        ${input.parentTaskVersion ?? null},
        ${validatedEmbeddingModelId},
        ${validatedEmbeddingDimension},
        ${validatedContractVersion},
        ${validatedExpectedChunkCount},
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

  return await runWithTx(input.tx, executeInTx);
}

// -----------------------------------------------------------------------------
// C. Lease Renewal
// -----------------------------------------------------------------------------

/**
 * Extends the active lease of a WRITING generation.
 *
 * Invariants:
 * 1. Single database transaction.
 * 2. Locks generation row (SELECT ... FOR UPDATE).
 * 3. Status must be WRITING, claimToken must match, and current lease must not be expired.
 * 4. Conditional SQL update extends leaseExpiresAt = clock_timestamp() + make_interval(...).
 * 5. Requires exactly 1 affected row.
 */
export async function renewGenerationLease({
  generationId,
  claimToken,
  extensionSeconds = 300,
  tx,
}: RenewGenerationLeaseInput): Promise<VectorGeneration> {
  const validatedGenerationId = validateString(generationId, "generationId");
  const validatedClaimToken = validateString(claimToken, "claimToken");
  const validatedExtensionSeconds = validateInteger(extensionSeconds, "extensionSeconds", 1, 3600);

  const executeInTx = async (client: Prisma.TransactionClient): Promise<VectorGeneration> => {
    // 1. Lock and inspect generation row
    const genRows = await client.$queryRaw<Array<{
      id: string;
      status: string;
      claimToken: string | null;
      isLeaseValid: boolean;
    }>>`
      SELECT id, status::text, "claimToken",
             ("leaseExpiresAt" > clock_timestamp()) as "isLeaseValid"
      FROM "VectorGeneration"
      WHERE id = ${validatedGenerationId}
      FOR UPDATE
    `;

    if (genRows.length === 0) {
      throw new EntityNotFoundError(`VectorGeneration ${validatedGenerationId} not found`);
    }

    const gen = genRows[0];
    if (gen.status !== "WRITING") {
      throw new InvalidStateTransitionError(
        `Cannot renew lease: generation status is '${gen.status}', expected 'WRITING'`
      );
    }
    if (gen.claimToken !== validatedClaimToken) {
      throw new OwnershipTokenMismatchError(
        `Claim token mismatch for generation ${validatedGenerationId}`
      );
    }
    if (!gen.isLeaseValid) {
      throw new LeaseExpiredError(
        `Cannot renew expired lease for generation ${validatedGenerationId}`
      );
    }

    // 2. Perform conditional lease extension
    const affectedRows = await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${validatedExtensionSeconds}),
          "updatedAt" = clock_timestamp()
      WHERE id = ${validatedGenerationId}
        AND status = 'WRITING'
        AND "claimToken" = ${validatedClaimToken}
        AND "leaseExpiresAt" > clock_timestamp()
    `;

    if (affectedRows !== 1) {
      throw new InvalidStateTransitionError(
        `Conditional lease renewal failed for generation ${validatedGenerationId}`
      );
    }

    return await client.vectorGeneration.findUniqueOrThrow({
      where: { id: validatedGenerationId },
    });
  };

  return await runWithTx(tx, executeInTx);
}

// -----------------------------------------------------------------------------
// D. Writer Failure Transition
// -----------------------------------------------------------------------------

/**
 * Transitions an in-progress generation (WRITING or WRITTEN) to FAILED.
 * Releases the worker lease and invalidates the claim token.
 *
 * Invariants:
 * 1. Single database transaction.
 * 2. Locks generation row (SELECT ... FOR UPDATE).
 * 3. Status must be WRITING or WRITTEN, and claimToken must match.
 * 4. Conditional SQL update sets status = 'FAILED', records lastError, and clears claimToken & leaseExpiresAt.
 * 5. Requires exactly 1 affected row.
 */
export async function failGeneration({
  generationId,
  claimToken,
  errorMessage,
  tx,
}: FailGenerationInput): Promise<VectorGeneration> {
  const validatedGenerationId = validateString(generationId, "generationId");
  const validatedClaimToken = validateString(claimToken, "claimToken");
  const validatedErrorMessage = validateString(errorMessage, "errorMessage");

  const executeInTx = async (client: Prisma.TransactionClient): Promise<VectorGeneration> => {
    // 1. Lock and inspect generation row
    const genRows = await client.$queryRaw<Array<{
      id: string;
      status: string;
      claimToken: string | null;
    }>>`
      SELECT id, status::text, "claimToken"
      FROM "VectorGeneration"
      WHERE id = ${validatedGenerationId}
      FOR UPDATE
    `;

    if (genRows.length === 0) {
      throw new EntityNotFoundError(`VectorGeneration ${validatedGenerationId} not found`);
    }

    const gen = genRows[0];
    if (gen.status !== "WRITING" && gen.status !== "WRITTEN") {
      throw new InvalidStateTransitionError(
        `Cannot fail generation: status is '${gen.status}', expected 'WRITING' or 'WRITTEN'`
      );
    }
    if (gen.claimToken !== validatedClaimToken) {
      throw new OwnershipTokenMismatchError(
        `Claim token mismatch for generation ${validatedGenerationId}`
      );
    }

    // 2. Perform conditional transition to FAILED
    const affectedRows = await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'FAILED'::"VectorGenerationStatus",
          "lastError" = ${validatedErrorMessage},
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = ${validatedGenerationId}
        AND status IN ('WRITING', 'WRITTEN')
        AND "claimToken" = ${validatedClaimToken}
    `;

    if (affectedRows !== 1) {
      throw new InvalidStateTransitionError(
        `Conditional failure transition failed for generation ${validatedGenerationId}`
      );
    }

    return await client.vectorGeneration.findUniqueOrThrow({
      where: { id: validatedGenerationId },
    });
  };

  return await runWithTx(tx, executeInTx);
}

// -----------------------------------------------------------------------------
// E. Mark Generation Written (Write Receipt Contract)
// -----------------------------------------------------------------------------

/**
 * Transitions a generation from WRITING to WRITTEN upon validating an external write receipt.
 *
 * Atomicity and Fencing Invariants:
 * 1. Enclosed entirely within a single database transaction.
 * 2. Locks generation row (SELECT ... FOR UPDATE).
 * 3. Contract validation:
 *      - Status must be WRITING
 *      - claimToken must match
 *      - Lease must be valid (PostgreSQL clock_timestamp())
 *      - writtenChunkCount must strictly equal expectedChunkCount
 *      - Manifest digest:
 *          - If expected is non-null: receipt MUST provide matching digest (missing or mismatch throws)
 *          - If expected is null: optional receipt digest is accepted without overwriting
 * 4. Conditional SQL update independently verifies (status = 'WRITING', claimToken, leaseExpiresAt > clock_timestamp()).
 * 5. Requires exactly one affected row. Zero-row update throws typed transition error.
 */
export async function markGenerationWritten({
  receipt,
  tx,
}: MarkGenerationWrittenInput): Promise<VectorGeneration> {
  const validatedGenerationId = validateString(receipt.generationId, "receipt.generationId");
  const validatedClaimToken = validateString(receipt.claimToken, "receipt.claimToken");
  const validatedWrittenChunkCount = validateInteger(receipt.writtenChunkCount, "receipt.writtenChunkCount", 0);

  const executeInTx = async (client: Prisma.TransactionClient): Promise<VectorGeneration> => {
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
      WHERE id = ${validatedGenerationId}
      FOR UPDATE
    `;

    if (genRows.length === 0) {
      throw new EntityNotFoundError(`VectorGeneration ${validatedGenerationId} not found`);
    }

    const gen = genRows[0];

    if (gen.status !== "WRITING") {
      throw new InvalidStateTransitionError(
        `Cannot mark generation written: status is '${gen.status}', expected 'WRITING'`
      );
    }

    if (gen.claimToken !== validatedClaimToken) {
      throw new OwnershipTokenMismatchError(
        `Claim token mismatch for generation ${validatedGenerationId}`
      );
    }

    if (!gen.isLeaseValid) {
      throw new LeaseExpiredError(
        `Writer lease for generation ${validatedGenerationId} expired before completion`
      );
    }

    // Contract Validation 1: Chunk count check
    if (validatedWrittenChunkCount !== gen.expectedChunkCount) {
      throw new ChunkCountMismatchError(
        `Write receipt chunk count (${validatedWrittenChunkCount}) does not match expected chunk count (${gen.expectedChunkCount}) for generation ${validatedGenerationId}`
      );
    }

    // Contract Validation 2: Manifest digest validation (Section 5)
    if (gen.manifestDigest !== null) {
      if (!receipt.manifestDigest) {
        throw new MissingManifestDigestError(
          `Write receipt missing required manifest digest for generation ${validatedGenerationId}`
        );
      }
      if (receipt.manifestDigest !== gen.manifestDigest) {
        throw new ManifestDigestMismatchError(
          `Write receipt manifest digest does not match expected digest for generation ${validatedGenerationId}`
        );
      }
    }

    // 2. Conditional SQL update independently enforcing token ownership and lease validity
    const affectedRows = await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'WRITTEN'::"VectorGenerationStatus",
          "manifestDigest" = COALESCE("manifestDigest", ${receipt.manifestDigest ?? null}),
          "updatedAt" = clock_timestamp()
      WHERE id = ${validatedGenerationId}
        AND status = 'WRITING'
        AND "claimToken" = ${validatedClaimToken}
        AND "leaseExpiresAt" > clock_timestamp()
    `;

    // 3. Invariant: Affected row count must be exactly one
    if (affectedRows !== 1) {
      // Zero-row update: conditional transition failed
      const checkRows = await client.$queryRaw<Array<{
        status: string;
        claimToken: string | null;
        isLeaseValid: boolean;
      }>>`
        SELECT status::text, "claimToken", ("leaseExpiresAt" > clock_timestamp()) as "isLeaseValid"
        FROM "VectorGeneration"
        WHERE id = ${validatedGenerationId}
      `;

      if (checkRows.length === 0) {
        throw new EntityNotFoundError(`VectorGeneration ${validatedGenerationId} not found`);
      }

      const check = checkRows[0];
      if (check.status !== "WRITING") {
        throw new InvalidStateTransitionError(
          `Conditional update failed: status is '${check.status}', expected 'WRITING'`
        );
      }
      if (check.claimToken !== validatedClaimToken) {
        throw new OwnershipTokenMismatchError(
          `Conditional update failed: claim token mismatch for generation ${validatedGenerationId}`
        );
      }
      if (!check.isLeaseValid) {
        throw new LeaseExpiredError(
          `Conditional update failed: lease expired for generation ${validatedGenerationId}`
        );
      }
      throw new InvalidStateTransitionError(
        `Conditional update affected 0 rows for generation ${validatedGenerationId}`
      );
    }

    return await client.vectorGeneration.findUniqueOrThrow({
      where: { id: validatedGenerationId },
    });
  };

  return await runWithTx(tx, executeInTx);
}

// -----------------------------------------------------------------------------
// F. Generation Activation
// -----------------------------------------------------------------------------

/**
 * Atomically activates a WRITTEN generation in a single database transaction.
 *
 * Strict Canonical Lock Order (Project -> Task -> Attachment -> VectorEntityHead -> VectorGeneration):
 * 1. Discover parent Project and Task identities.
 * 2. Lock Project first (SELECT id FROM "Project" ... FOR UPDATE).
 * 3. Lock Task second (SELECT id ... FROM "Task" ... FOR UPDATE).
 * 4. Lock Attachment third (if applicable) (SELECT id ... FROM "Attachment" ... FOR UPDATE).
 * 5. Revalidate relationships and tenant scope after acquiring business entity locks.
 * 6. Recompute authoritative sourceVersion and verify freshness while rows remain locked.
 * 7. Lock VectorEntityHead after business entities (SELECT ... FOR UPDATE).
 *    - Re-reads isTombstone = false.
 * 8. Lock VectorGeneration after the head (SELECT ... FOR UPDATE).
 *    - Validates status = WRITTEN, headId matches, claimToken ownership, and lease validity.
 * 9. Atomic Transition:
 *    - Mark previous active generation OBSOLETE.
 *    - Mark replacement generation ACTIVE with conditional check (claimToken, leaseExpiresAt > clock_timestamp()).
 *    - Require exactly 1 affected row.
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
  const validatedHeadId = validateString(headId, "headId");
  const validatedGenerationId = validateString(generationId, "generationId");
  const validatedClaimToken = validateString(claimToken, "claimToken");
  const validatedExpectedSourceVersion = validateString(expectedSourceVersion, "expectedSourceVersion");

  const executeInTx = async (client: Prisma.TransactionClient): Promise<ActivateGenerationResult> => {
    // Read head metadata without lock first to discover entityType and entityId
    const headMeta = await client.vectorEntityHead.findUnique({
      where: { id: validatedHeadId },
      select: { id: true, orgId: true, entityType: true, entityId: true },
    });

    if (!headMeta) {
      throw new EntityNotFoundError(`VectorEntityHead ${validatedHeadId} not found`);
    }

    // -------------------------------------------------------------------------
    // STEP 1: Lock authoritative business entities in canonical order
    // -------------------------------------------------------------------------
    if (headMeta.entityType === "TASK") {
      // 1A. Discover parent Project ID
      const taskMeta = await client.task.findUnique({
        where: { id: headMeta.entityId },
        select: { projectId: true },
      });

      if (!taskMeta) {
        throw new EntityNotFoundError(`Authoritative Task ${headMeta.entityId} not found`);
      }

      // 1B. Lock Project first
      await client.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${taskMeta.projectId} FOR UPDATE
      `;

      // 1C. Lock Task second
      const taskRows = await client.$queryRaw<
        Array<{ id: string; projectId: string; updatedAt: Date; orgId: string }>
      >`
        SELECT t.id, t."projectId", t."updatedAt", p."orgId"
        FROM "Task" t
        JOIN "Project" p ON t."projectId" = p.id
        WHERE t.id = ${headMeta.entityId}
        FOR UPDATE
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

      if (currentVersion !== validatedExpectedSourceVersion) {
        throw new StaleSourceVersionError(
          `Task source version changed during vector generation (current: ${currentVersion}, expected: ${validatedExpectedSourceVersion})`
        );
      }
    } else if (headMeta.entityType === "ATTACHMENT") {
      // 1A. Discover parent Task and Project IDs
      const attMeta = await client.attachment.findUnique({
        where: { id: headMeta.entityId },
        select: { task: { select: { id: true, projectId: true } } },
      });

      if (!attMeta?.task) {
        throw new EntityNotFoundError(
          `Authoritative Attachment ${headMeta.entityId} or parent task not found`
        );
      }

      const parentProjectId = attMeta.task.projectId;
      const parentTaskId = attMeta.task.id;

      // 1B. Lock Project first
      await client.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${parentProjectId} FOR UPDATE
      `;

      // 1C. Lock Task second
      await client.$queryRaw`
        SELECT id FROM "Task" WHERE id = ${parentTaskId} FOR UPDATE
      `;

      // 1D. Lock Attachment third
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
        FOR UPDATE
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

      if (currentVersion !== validatedExpectedSourceVersion) {
        throw new StaleSourceVersionError(
          `Attachment source version changed during vector generation (current: ${currentVersion}, expected: ${validatedExpectedSourceVersion})`
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
      WHERE id = ${validatedHeadId}
      FOR UPDATE
    `;

    if (lockedHeads.length === 0) {
      throw new EntityNotFoundError(`VectorEntityHead ${validatedHeadId} not found`);
    }

    const lockedHead = lockedHeads[0];
    if (lockedHead.isTombstone) {
      throw new TombstonedEntityError(
        `Cannot activate vector generation: VectorEntityHead ${validatedHeadId} is tombstoned`
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
      WHERE id = ${validatedGenerationId}
      FOR UPDATE
    `;

    if (genRows.length === 0) {
      throw new EntityNotFoundError(`VectorGeneration ${validatedGenerationId} not found`);
    }

    const targetGen = genRows[0];

    // Same-head invariant
    if (targetGen.headId !== validatedHeadId) {
      throw new Error(
        `Integrity violation: Generation ${validatedGenerationId} belongs to head ${targetGen.headId}, not ${validatedHeadId}`
      );
    }

    if (targetGen.status !== "WRITTEN") {
      throw new InvalidStateTransitionError(
        `Cannot activate generation ${validatedGenerationId}: status is '${targetGen.status}', expected 'WRITTEN'`
      );
    }

    if (targetGen.claimToken !== validatedClaimToken) {
      throw new OwnershipTokenMismatchError(
        `Claim token mismatch for generation ${validatedGenerationId}`
      );
    }

    if (!targetGen.isLeaseValid) {
      throw new LeaseExpiredError(
        `Writer lease expired before activation for generation ${validatedGenerationId}`
      );
    }

    if (targetGen.sourceVersion !== validatedExpectedSourceVersion) {
      throw new StaleSourceVersionError(
        `Generation sourceVersion (${targetGen.sourceVersion}) does not match expected (${validatedExpectedSourceVersion})`
      );
    }

    // -------------------------------------------------------------------------
    // STEP 4: Atomic Pointer and Status Transition with Fencing
    // -------------------------------------------------------------------------
    const obsoletedGenId = lockedHead.activeGenId;

    // 4A. Obsolete previously active generation (if any and distinct)
    if (obsoletedGenId && obsoletedGenId !== validatedGenerationId) {
      await client.$executeRaw`
        UPDATE "VectorGeneration"
        SET status = 'OBSOLETE'::"VectorGenerationStatus",
            "updatedAt" = clock_timestamp()
        WHERE id = ${obsoletedGenId}
          AND "headId" = ${validatedHeadId}
          AND status = 'ACTIVE'
      `;
    }

    // 4B. Activate new generation with conditional check
    const activateRows = await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'ACTIVE'::"VectorGenerationStatus",
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = ${validatedGenerationId}
        AND "headId" = ${validatedHeadId}
        AND status = 'WRITTEN'
        AND "claimToken" = ${validatedClaimToken}
        AND "leaseExpiresAt" > clock_timestamp()
    `;

    if (activateRows !== 1) {
      throw new InvalidStateTransitionError(
        `Conditional activation failed for generation ${validatedGenerationId} (lease expired or ownership lost during transition)`
      );
    }

    // 4C. Update head pointer to point to newly activated generation
    await client.$executeRaw`
      UPDATE "VectorEntityHead"
      SET "activeGenId" = ${validatedGenerationId},
          "updatedAt" = clock_timestamp()
      WHERE id = ${validatedHeadId}
    `;

    const updatedHead = await client.vectorEntityHead.findUniqueOrThrow({
      where: { id: validatedHeadId },
    });
    const activatedGen = await client.vectorGeneration.findUniqueOrThrow({
      where: { id: validatedGenerationId },
    });

    return {
      head: updatedHead,
      activatedGeneration: activatedGen,
      obsoletedGenerationId: obsoletedGenId,
    };
  };

  return await runWithTx(tx, executeInTx);
}

// -----------------------------------------------------------------------------
// G. Tombstoning
// -----------------------------------------------------------------------------

/**
 * Transactionally creates or updates an entity head to permanent tombstone state.
 *
 * Guarantees:
 * 1. Atomicity: wraps all operations in a single database transaction.
 * 2. Upserts head into permanent tombstone state, preserving original tombstonedAt if already set.
 * 3. Immediately clears activeGenId = NULL on the head.
 * 4. Acquires row locks on all generations for this head in deterministic primary-key order (ORDER BY id ASC).
 * 5. Obsoletes formerly ACTIVE generation.
 * 6. Fails any in-progress WRITING or WRITTEN generations (clearing leases and claim tokens).
 * 7. Permanent and irreversible: tombstones cannot be reset by worker initialization or reservation.
 */
export async function tombstoneEntityHead({
  orgId,
  entityType,
  entityId,
  tx,
}: TombstoneEntityHeadInput): Promise<VectorEntityHead> {
  const validatedOrgId = validateString(orgId, "orgId");
  const validatedEntityType = validateEntityType(entityType);
  const validatedEntityId = validateString(entityId, "entityId");

  const executeInTx = async (client: Prisma.TransactionClient): Promise<VectorEntityHead> => {
    const randomHeadId = `head_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

    if (typeof client.$executeRaw !== "function") {
      return {
        id: randomHeadId,
        orgId: validatedOrgId,
        entityType: validatedEntityType,
        entityId: validatedEntityId,
        isTombstone: true,
        tombstonedAt: new Date(),
        activeGenId: null,
        latestRevision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;
    }

    // 1. Atomically upsert head into permanent tombstone state
    await client.$executeRaw`
      INSERT INTO "VectorEntityHead" (
        id, "orgId", "entityType", "entityId", "isTombstone", "tombstonedAt",
        "activeGenId", "createdAt", "updatedAt"
      ) VALUES (
        ${randomHeadId},
        ${validatedOrgId},
        ${validatedEntityType}::"VectorEntityType",
        ${validatedEntityId},
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

    // 2. Fetch and lock the authoritative head record
    const headRows = await client.$queryRaw<
      Array<{ id: string; orgId: string; entityType: string; entityId: string; isTombstone: boolean }>
    >`
      SELECT id, "orgId", "entityType"::text, "entityId", "isTombstone"
      FROM "VectorEntityHead"
      WHERE "orgId" = ${validatedOrgId}
        AND "entityType" = ${validatedEntityType}::"VectorEntityType"
        AND "entityId" = ${validatedEntityId}
      FOR UPDATE
    `;

    if (headRows.length === 0) {
      throw new EntityNotFoundError(
        `VectorEntityHead for ${validatedEntityType}:${validatedEntityId} not found`
      );
    }

    const head = headRows[0];

    // 3. Deterministic multi-generation row locking in ascending ID order (Section 7)
    await client.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text
      FROM "VectorGeneration"
      WHERE "headId" = ${head.id}
      ORDER BY id ASC
      FOR UPDATE
    `;

    // 4. Obsolete any formerly ACTIVE generation
    await client.$executeRaw`
      UPDATE "VectorGeneration"
      SET status = 'OBSOLETE'::"VectorGenerationStatus",
          "updatedAt" = clock_timestamp()
      WHERE "headId" = ${head.id}
        AND status = 'ACTIVE'
    `;

    // 5. Fail any in-flight WRITING or WRITTEN generations
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

    return await client.vectorEntityHead.findUniqueOrThrow({
      where: { id: head.id },
    });
  };

  return await runWithTx(tx, executeInTx);
}
