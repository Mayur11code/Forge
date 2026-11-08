-- Migration: 20261105000000_vector_v2_outbox_model
-- Vector V2 Phase B: Transactional Outbox, Source Revision Tracking & Database-Clock EventLog Leases

-- CreateEnum: VectorOutboxStatus
DO $$ BEGIN
  CREATE TYPE "VectorOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'DISPATCHED', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: VectorEntityHead add latestRevision
ALTER TABLE "VectorEntityHead" ADD COLUMN IF NOT EXISTS "latestRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: EventLog add outboxEventId, claimToken, leaseExpiresAt
ALTER TABLE "EventLog" ADD COLUMN IF NOT EXISTS "outboxEventId" TEXT;
ALTER TABLE "EventLog" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
ALTER TABLE "EventLog" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

-- CreateTable: VectorOutboxEvent
CREATE TABLE IF NOT EXISTS "VectorOutboxEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityType" "VectorEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL DEFAULT 'v2',
    "parentTaskVersion" TEXT,
    "status" "VectorOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dispatchClaimToken" TEXT,
    "dispatchLeaseExpiresAt" TIMESTAMP(3),
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastDispatchedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "terminalError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- Partial Unique Index: VectorOutboxEvent non-blocking pending coalescing
CREATE UNIQUE INDEX IF NOT EXISTS "VectorOutboxEvent_pending_entity_idx" 
ON "VectorOutboxEvent" ("entityType", "entityId") 
WHERE "status" = 'PENDING';

-- Supporting Indexes: VectorOutboxEvent
CREATE INDEX IF NOT EXISTS "VectorOutboxEvent_status_nextRetryAt_idx" 
ON "VectorOutboxEvent" ("status", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "VectorOutboxEvent_status_dispatchLeaseExpiresAt_idx" 
ON "VectorOutboxEvent" ("status", "dispatchLeaseExpiresAt");

CREATE INDEX IF NOT EXISTS "VectorOutboxEvent_orgId_entityType_entityId_idx" 
ON "VectorOutboxEvent" ("orgId", "entityType", "entityId");

-- EventLog Indexes
CREATE INDEX IF NOT EXISTS "EventLog_status_leaseExpiresAt_idx" 
ON "EventLog" ("status", "leaseExpiresAt");

CREATE INDEX IF NOT EXISTS "EventLog_outboxEventId_idx" 
ON "EventLog" ("outboxEventId");

-- Partial Unique Index: EventLog active outbox claim
CREATE UNIQUE INDEX IF NOT EXISTS "EventLog_outbox_active_idx" 
ON "EventLog" ("outboxEventId") 
WHERE "outboxEventId" IS NOT NULL AND "status" = 'PENDING';
