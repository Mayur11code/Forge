-- Phase 2: durable approval expiry for agent tool proposals.
--
-- Closes a real production gap: PENDING_CONFIRMATION previously had no
-- expiration, so a user who simply never answered left the session waiting
-- forever. The reaper could not help either, because a proposal awaiting a
-- human is not "orphaned" in the sense the reaper detects -- it is parked
-- exactly where the system put it.
--
-- Additive only. Nothing is dropped or rewritten.
--
--   * EXPIRED is a distinct terminal state from CANCELLED, on purpose.
--     CANCELLED means a user actively declined. EXPIRED means the window
--     elapsed with no answer. Collapsing them would misreport intent in the
--     audit trail and in what the model is told to tell the user.
--   * expiresAt is an explicit deadline written at proposal time. It is
--     deliberately NOT derived from updatedAt: any unrelated write to the row
--     would push an updatedAt-derived deadline into the future and let a
--     proposal live indefinitely.
--   * expiredAt records when the timeout was actually observed, so "deadline"
--     and "acted on" can never be conflated.
--
-- Note on reversibility: ALTER TYPE ... ADD VALUE cannot be rolled back in
-- PostgreSQL. Once this migration commits, 'EXPIRED' exists permanently. The
-- database is therefore expected to be a non-production target for the initial
-- application of this migration.

-- AlterEnum
ALTER TYPE "AgentToolExecutionStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "AgentToolExecution" ADD COLUMN     "expiresAt" TIMESTAMP(3);
ALTER TABLE "AgentToolExecution" ADD COLUMN     "expiredAt" TIMESTAMP(3);

-- CreateIndex
-- Backs the bounded maintenance scan:
--   WHERE status = 'PENDING_CONFIRMATION' AND expiresAt <= now()
--   ORDER BY expiresAt LIMIT <batch>
-- Without this the reaper would degrade into a sequential scan as rows accumulate.
CREATE INDEX "AgentToolExecution_status_expiresAt_idx" ON "AgentToolExecution"("status", "expiresAt");
