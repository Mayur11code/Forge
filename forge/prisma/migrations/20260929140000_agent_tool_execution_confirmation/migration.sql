-- Phase 2: durable confirmation state for agent tool proposals.
--
-- Additive only. No data is dropped or rewritten:
--   * PENDING_CONFIRMATION is the persisted proposal state, held until the user
--     confirms or cancels.
--   * CANCELLED is terminal; a cancelled proposal can never be resurrected and
--     is never dispatched to the tool worker.
--   * confirmedAt / cancelledAt are an audit trail. The proposal arguments stay
--     in the existing `input` column and are never regenerated at confirm time.

-- AlterEnum
ALTER TYPE "AgentToolExecutionStatus" ADD VALUE 'PENDING_CONFIRMATION';
ALTER TYPE "AgentToolExecutionStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "AgentToolExecution" ADD COLUMN     "confirmedAt" TIMESTAMP(3);
ALTER TABLE "AgentToolExecution" ADD COLUMN     "cancelledAt" TIMESTAMP(3);
