-- CreateEnum
CREATE TYPE "DomainOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "DomainOutboxEvent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DomainOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainOutboxEvent_idempotencyKey_key" ON "DomainOutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DomainOutboxEvent_status_availableAt_idx" ON "DomainOutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "DomainOutboxEvent_orgId_resourceType_resourceId_idx" ON "DomainOutboxEvent"("orgId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "DomainOutboxEvent_createdAt_idx" ON "DomainOutboxEvent"("createdAt");
