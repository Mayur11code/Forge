-- CreateEnum
CREATE TYPE "WorkflowOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'RETRYING', 'DEAD_LETTERED');

-- CreateTable
CREATE TABLE "WorkflowOutbox" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepRunId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "WorkflowOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "dispatchGeneration" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowOutbox_dedupeKey_key" ON "WorkflowOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "WorkflowOutbox_status_nextAttemptAt_idx" ON "WorkflowOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WorkflowOutbox_runId_idx" ON "WorkflowOutbox"("runId");

-- CreateIndex
CREATE INDEX "WorkflowOutbox_stepRunId_idx" ON "WorkflowOutbox"("stepRunId");

-- CreateIndex
CREATE INDEX "WorkflowOutbox_orgId_idx" ON "WorkflowOutbox"("orgId");

-- CreateIndex
CREATE INDEX "WorkflowOutbox_leaseExpiresAt_idx" ON "WorkflowOutbox"("leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "WorkflowOutbox" ADD CONSTRAINT "WorkflowOutbox_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowOutbox" ADD CONSTRAINT "WorkflowOutbox_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "StepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
