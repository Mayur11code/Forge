-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR', 'FATAL');

-- CreateTable
CREATE TABLE "ExecutionAuditLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "logLevel" "LogLevel" NOT NULL DEFAULT 'INFO',
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionAuditLog_runId_idx" ON "ExecutionAuditLog"("runId");

-- CreateIndex
CREATE INDEX "ExecutionAuditLog_stepId_idx" ON "ExecutionAuditLog"("stepId");

-- CreateIndex
CREATE INDEX "ExecutionAuditLog_eventType_idx" ON "ExecutionAuditLog"("eventType");

-- CreateIndex
CREATE INDEX "ExecutionAuditLog_createdAt_idx" ON "ExecutionAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "ExecutionAuditLog" ADD CONSTRAINT "ExecutionAuditLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAuditLog" ADD CONSTRAINT "ExecutionAuditLog_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "StepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
