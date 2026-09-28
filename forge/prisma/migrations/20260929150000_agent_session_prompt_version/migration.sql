-- Phase 2: prompt provenance on AgentSession.
--
-- Additive only: existing rows are backfilled from the column default.
--
-- The default is 'v1', the contract those sessions actually ran under, NOT the
-- current 'v2'. Backfilling the current version would assert provenance for
-- history that predates the new contract - a lie that is invisible precisely
-- because it looks correct. New sessions are unaffected: createAgentSession
-- writes AGENT_PROMPT_VERSION explicitly, so the default is only ever seen by
-- rows that predate this migration.

-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "promptVersion" TEXT NOT NULL DEFAULT 'v1';
