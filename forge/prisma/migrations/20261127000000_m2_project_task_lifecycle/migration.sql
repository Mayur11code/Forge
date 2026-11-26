-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Project_archivedAt_idx" ON "Project"("archivedAt");

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "completedAt" TIMESTAMP(3);
