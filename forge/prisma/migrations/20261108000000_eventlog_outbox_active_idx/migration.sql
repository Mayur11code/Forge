-- Migration: 20261108000000_eventlog_outbox_active_idx
-- Forward Migration: Hardens EventLog logical work idempotency across PENDING and SUCCESS states (Phase B Rev 3.2 Area D2)

-- Drop the previous partial unique index covering only PENDING status
DROP INDEX IF EXISTS "EventLog_outbox_active_idx";

-- Create partial unique index enforcing uniqueness for active and completed outbox executions
CREATE UNIQUE INDEX IF NOT EXISTS "EventLog_outbox_active_idx"
ON "EventLog" ("outboxEventId")
WHERE "outboxEventId" IS NOT NULL
  AND ("status" = 'PENDING'::"EventStatus" OR "status" = 'SUCCESS'::"EventStatus");
