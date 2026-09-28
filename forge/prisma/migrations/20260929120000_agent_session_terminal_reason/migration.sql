-- AlterTable
-- Adds a machine-readable terminal reason for AgentSession.
-- errorMessage stays human-facing; terminalReason is for programmatic branching.
ALTER TABLE "AgentSession" ADD COLUMN     "terminalReason" TEXT;

-- CreateIndex
CREATE INDEX "AgentSession_terminalReason_idx" ON "AgentSession"("terminalReason");
