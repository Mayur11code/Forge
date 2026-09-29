-- Phase 2: transactional outbox for critical agent events.
--
-- Closes the last durability gap in the agent loop:
--
--   DB write  ->  process dies  ->  event publish never happens
--
-- Previously the agent persisted domain state and then published to QStash as
-- two separate steps. A crash in between left the database asserting that work
-- was required while the event was gone for good, and the session hung until
-- the reaper eventually noticed. This table makes the publish *intent* part of
-- the same transaction as the domain state, so the two commit or roll back
-- together.
--
-- EventLog could not be reused for this. It is written by the consumer after
-- the broker delivers, keyed on a broker-assigned messageId that does not
-- exist at publish time, and it carries no retry scheduling fields. It is a
-- dedup ledger, not an outbox.
--
-- Delivery semantics, stated precisely so nothing overclaims:
--   * durable intent          -- the row is committed with the domain state
--   * at-least-once delivery  -- a crash after send but before marking
--                                 PUBLISHED causes a redelivery
--   * idempotent consumers    -- EventLog(messageId) dedup and the CAS state
--                                 machine absorb the duplicate
--   * NOT exactly-once        -- explicitly not claimed
--
-- sessionId / executionId are intentionally NOT foreign keys. An outbox row is
-- a promise to deliver; cascading it away with the session would delete the
-- promise before it was kept.

-- CreateEnum
CREATE TYPE "AgentOutboxStatus" AS ENUM ('PENDING', 'PUBLISHED');

-- CreateTable
CREATE TABLE "AgentOutboxEvent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sessionId" TEXT,
    "executionId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "AgentOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "AgentOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Deterministic producer-side idempotency. The unique constraint is what makes
-- a retried or duplicated write collapse into one logical record instead of
-- fanning out into several.
CREATE UNIQUE INDEX "AgentOutboxEvent_idempotencyKey_key" ON "AgentOutboxEvent"("idempotencyKey");

-- CreateIndex
-- Carries the published messageId so the consumer can dedup with the existing
-- EventLog(messageId) protection.
CREATE UNIQUE INDEX "AgentOutboxEvent_messageId_key" ON "AgentOutboxEvent"("messageId");

-- CreateIndex
-- Backs the bounded dispatcher claim:
--   WHERE status = 'PENDING' AND availableAt <= now() ORDER BY availableAt
CREATE INDEX "AgentOutboxEvent_status_availableAt_idx" ON "AgentOutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AgentOutboxEvent_sessionId_idx" ON "AgentOutboxEvent"("sessionId");

-- CreateIndex
CREATE INDEX "AgentOutboxEvent_executionId_idx" ON "AgentOutboxEvent"("executionId");
