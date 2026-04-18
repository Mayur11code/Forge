/*
  Warnings:

  - You are about to drop the column `logs` on the `WorkflowRun` table. All the data in the column will be lost.
  - The `status` column on the `WorkflowRun` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "WorkflowExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "StepExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'RETRYING');

-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "logs",
ADD COLUMN     "context" JSONB NOT NULL DEFAULT '{}',
DROP COLUMN "status",
ADD COLUMN     "status" "WorkflowExecutionStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "StepRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "status" "StepExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "inputs" JSONB,
    "outputs" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StepRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepRun_runId_idx" ON "StepRun"("runId");

-- CreateIndex
CREATE INDEX "StepRun_runId_status_idx" ON "StepRun"("runId", "status");

-- CreateIndex
CREATE INDEX "StepRun_stepId_idx" ON "StepRun"("stepId");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_idx" ON "WorkflowRun"("status");

-- AddForeignKey
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
