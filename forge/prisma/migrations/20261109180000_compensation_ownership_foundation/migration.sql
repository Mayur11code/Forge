-- AlterEnum
ALTER TYPE "StepExecutionStatus" ADD VALUE 'COMPENSATION_RETRYING';

-- AlterTable
ALTER TABLE "StepRun" ADD COLUMN "compensationClaimToken" TEXT;
ALTER TABLE "StepRun" ADD COLUMN "compensationLeaseExpiresAt" TIMESTAMP(3);
