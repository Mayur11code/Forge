-- CreateEnum
CREATE TYPE "VectorEntityType" AS ENUM ('TASK', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "VectorGenerationStatus" AS ENUM ('WRITING', 'WRITTEN', 'ACTIVE', 'OBSOLETE', 'PURGING', 'PURGED', 'FAILED');

-- CreateTable
CREATE TABLE "VectorEntityHead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityType" "VectorEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "activeGenId" TEXT,
    "isTombstone" BOOLEAN NOT NULL DEFAULT false,
    "tombstonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorEntityHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorGeneration" (
    "id" TEXT NOT NULL,
    "headId" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "parentTaskVersion" TEXT,
    "embeddingModelId" TEXT NOT NULL,
    "embeddingDimension" INTEGER NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "expectedChunkCount" INTEGER NOT NULL,
    "manifestDigest" TEXT,
    "status" "VectorGenerationStatus" NOT NULL DEFAULT 'WRITING',
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "writeAttempts" INTEGER NOT NULL DEFAULT 0,
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VectorEntityHead_activeGenId_key" ON "VectorEntityHead"("activeGenId");

-- CreateIndex
CREATE INDEX "VectorEntityHead_entityId_idx" ON "VectorEntityHead"("entityId");

-- CreateIndex
CREATE INDEX "VectorEntityHead_orgId_isTombstone_idx" ON "VectorEntityHead"("orgId", "isTombstone");

-- CreateIndex
CREATE UNIQUE INDEX "VectorEntityHead_orgId_entityType_entityId_key" ON "VectorEntityHead"("orgId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorGeneration_id_headId_key" ON "VectorGeneration"("id", "headId");

-- CreateIndex
CREATE INDEX "VectorGeneration_headId_status_idx" ON "VectorGeneration"("headId", "status");

-- CreateIndex
CREATE INDEX "VectorGeneration_status_leaseExpiresAt_idx" ON "VectorGeneration"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "VectorGeneration_claimToken_idx" ON "VectorGeneration"("claimToken");

-- Partial Unique Index: Prevent more than one ACTIVE generation per head
CREATE UNIQUE INDEX "idx_vector_gen_active_per_head" ON "VectorGeneration" ("headId") WHERE status = 'ACTIVE';

-- AddForeignKey: VectorGeneration -> VectorEntityHead (Permanent History: RESTRICT on delete)
ALTER TABLE "VectorGeneration" ADD CONSTRAINT "VectorGeneration_headId_fkey" FOREIGN KEY ("headId") REFERENCES "VectorEntityHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: VectorEntityHead.activeGenId -> VectorGeneration.id
ALTER TABLE "VectorEntityHead" ADD CONSTRAINT "VectorEntityHead_activeGenId_fkey" FOREIGN KEY ("activeGenId") REFERENCES "VectorGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CheckConstraint: A tombstoned head must not have an active generation pointer
ALTER TABLE "VectorEntityHead" ADD CONSTRAINT "chk_head_tombstone_no_active_gen" CHECK ("isTombstone" = false OR "activeGenId" IS NULL);

-- CheckConstraint: A generation lease must not exist without its ownership token
ALTER TABLE "VectorGeneration" ADD CONSTRAINT "chk_gen_lease_requires_claim_token" CHECK ("leaseExpiresAt" IS NULL OR "claimToken" IS NOT NULL);
