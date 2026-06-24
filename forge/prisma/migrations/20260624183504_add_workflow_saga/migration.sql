/*
  Warnings:

  - A unique constraint covering the columns `[runId,stepId]` on the table `StepRun` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('RUNNING', 'WAITING_CONFIRMATION', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentToolExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StepExecutionStatus" ADD VALUE 'SKIPPED';
ALTER TYPE "StepExecutionStatus" ADD VALUE 'COMPENSATING';
ALTER TYPE "StepExecutionStatus" ADD VALUE 'COMPENSATED';
ALTER TYPE "StepExecutionStatus" ADD VALUE 'COMPENSATION_FAILED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowExecutionStatus" ADD VALUE 'ROLLING_BACK';
ALTER TYPE "WorkflowExecutionStatus" ADD VALUE 'ROLLED_BACK';
ALTER TYPE "WorkflowExecutionStatus" ADD VALUE 'REQUIRES_INTERVENTION';

-- AlterTable
ALTER TABLE "StepRun" ADD COLUMN     "compensationAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'RUNNING',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "finalResponse" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToolExecution" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "status" "AgentToolExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_orgId_userId_createdAt_idx" ON "AgentSession"("orgId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_userId_updatedAt_idx" ON "AgentSession"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentSession_status_updatedAt_idx" ON "AgentSession"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolExecution_toolCallId_key" ON "AgentToolExecution"("toolCallId");

-- CreateIndex
CREATE INDEX "AgentToolExecution_sessionId_createdAt_idx" ON "AgentToolExecution"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentToolExecution_sessionId_status_idx" ON "AgentToolExecution"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StepRun_runId_stepId_key" ON "StepRun"("runId", "stepId");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolExecution" ADD CONSTRAINT "AgentToolExecution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
