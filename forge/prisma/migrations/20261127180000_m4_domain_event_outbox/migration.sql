-- M4 (FC-017 / FC-018 / FC-019): Real Event Triggers, DomainEventOutbox & WorkflowTriggerDispatch ledger

-- 1. Extend Task with origin metadata for workflow suppression and audit
ALTER TABLE "Task"
  ADD COLUMN "originType" TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN "originWorkflowId" TEXT,
  ADD COLUMN "originWorkflowVersionId" TEXT,
  ADD COLUMN "originWorkflowRunId" TEXT;

CREATE INDEX "Task_originType_idx" ON "Task"("originType");

-- 2. Create DomainEventOutbox
CREATE TABLE "DomainEventOutbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "originType" TEXT NOT NULL DEFAULT 'USER',
    "originWorkflowId" TEXT,
    "originWorkflowVersionId" TEXT,
    "originWorkflowRunId" TEXT,
    "workflowEligible" BOOLEAN NOT NULL DEFAULT true,
    "suppressionReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainEventOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DomainEventOutbox_eventId_key" ON "DomainEventOutbox"("eventId");
CREATE INDEX "DomainEventOutbox_workflowEligible_status_nextAttemptAt_idx" ON "DomainEventOutbox"("workflowEligible", "status", "nextAttemptAt");
CREATE INDEX "DomainEventOutbox_status_nextAttemptAt_idx" ON "DomainEventOutbox"("status", "nextAttemptAt");
CREATE INDEX "DomainEventOutbox_orgId_eventType_idx" ON "DomainEventOutbox"("orgId", "eventType");
CREATE INDEX "DomainEventOutbox_createdAt_idx" ON "DomainEventOutbox"("createdAt");

-- 3. Create WorkflowTriggerDispatch
CREATE TABLE "WorkflowTriggerDispatch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTriggerDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowTriggerDispatch_eventId_workflowId_key" ON "WorkflowTriggerDispatch"("eventId", "workflowId");
CREATE UNIQUE INDEX "WorkflowTriggerDispatch_runId_key" ON "WorkflowTriggerDispatch"("runId");
CREATE INDEX "WorkflowTriggerDispatch_workflowId_status_idx" ON "WorkflowTriggerDispatch"("workflowId", "status");
CREATE INDEX "WorkflowTriggerDispatch_orgId_status_idx" ON "WorkflowTriggerDispatch"("orgId", "status");
CREATE INDEX "WorkflowTriggerDispatch_status_leaseExpiresAt_idx" ON "WorkflowTriggerDispatch"("status", "leaseExpiresAt");

-- 4. Foreign Key Constraints
ALTER TABLE "WorkflowTriggerDispatch"
  ADD CONSTRAINT "WorkflowTriggerDispatch_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "DomainEventOutbox"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowTriggerDispatch"
  ADD CONSTRAINT "WorkflowTriggerDispatch_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowTriggerDispatch"
  ADD CONSTRAINT "WorkflowTriggerDispatch_workflowVersionId_fkey"
  FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowTriggerDispatch"
  ADD CONSTRAINT "WorkflowTriggerDispatch_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
