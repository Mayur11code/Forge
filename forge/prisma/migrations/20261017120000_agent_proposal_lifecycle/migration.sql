-- Assignment 37.8 (F4) — durable proposal lifecycle.
--
-- Extends `AgentToolExecution` (Option A of the F4 fork) rather than introducing
-- a dedicated `WorkflowProposal` model: the execution row already holds the
-- immutable proposal (`input`), the approval audit trail, and is addressed by a
-- unique `toolCallId`, so it is already the interaction handle that clarification
-- and criticality bind to. Adding `result` plus the proposal columns here keeps a
-- single state machine and avoids a second lifecycle to keep in sync.
--
-- The proposal state is a NEW enum, deliberately separate from
-- `AgentToolExecutionStatus`. Execution status answers "did the tool run?";
-- proposal state answers "where is the human decision?". A single enum could not
-- express "ran successfully, now parked on a human" honestly.
--
-- Generated offline with `prisma migrate diff --from-schema <pre-37.8>
-- --to-schema prisma/schema.prisma --script` (an initial reachability attempt
-- returned P1001). A later `prisma migrate status` did connect and reports this
-- migration as still UNAPPLIED; it must not be migrated against until that is
-- deliberate.

-- CreateEnum
--
-- Assignment 37.9 amends this still-UNAPPLIED migration in place to add the two
-- terminal human-decision states, rather than adding a second migration that
-- would have to `ALTER TYPE ... ADD VALUE` against a type that does not exist
-- yet on any database. DECLINED is a deliberate human refusal; EXPIRED is the
-- system closing a review window nobody answered. They are separate states
-- because conflating them would report a timeout as a user decision.
CREATE TYPE "AgentProposalState" AS ENUM ('VALIDATED', 'NEEDS_CLARIFICATION', 'CLARIFICATION_ACCEPTED', 'AWAITING_CRITICALITY', 'AWAITING_APPROVAL', 'APPROVED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'INVALID', 'MATERIALIZED');

-- AlterTable
ALTER TABLE "AgentToolExecution" ADD COLUMN     "clarificationAnswer" JSONB,
ADD COLUMN     "criticalityDecisions" JSONB,
ADD COLUMN     "proposalFingerprint" TEXT,
ADD COLUMN     "proposalRevision" INTEGER,
ADD COLUMN     "proposalState" "AgentProposalState",
ADD COLUMN     "result" JSONB;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "sourceProposalId" TEXT;

-- CreateIndex
CREATE INDEX "AgentToolExecution_sessionId_proposalState_idx" ON "AgentToolExecution"("sessionId", "proposalState");

-- CreateIndex
-- Assignment 37.9: backs the proposal-review expiry sweep
-- (WHERE proposalState = AWAITING_APPROVAL AND expiresAt <= now()).
CREATE INDEX "AgentToolExecution_proposalState_expiresAt_idx" ON "AgentToolExecution"("proposalState", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_sourceProposalId_key" ON "Workflow"("sourceProposalId");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_sourceProposalId_fkey" FOREIGN KEY ("sourceProposalId") REFERENCES "AgentToolExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
