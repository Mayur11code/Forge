// src/app/api/worker/domain-maintenance/dm.ts
//
// Scheduled background maintenance pass for the domain deletion outbox.
//
// Arrives through the single /api/worker dispatcher from a recurring QStash schedule,
// inheriting cryptographic signature verification and execution logging.
// Reclaims and dispatches due PENDING and abandoned DISPATCHED outbox events in bounded batches.

import { dispatchDomainOutboxBatch } from "@/lib/deletion/outbox";
import type { EventPayloadMap } from "@/lib/events/schema";

export interface DomainMaintenanceWorkerEvent {
  event: {
    data: EventPayloadMap["DOMAIN_MAINTENANCE_REQUESTED"];
  };
}

export async function handleDomainMaintenance({
  event,
}: DomainMaintenanceWorkerEvent): Promise<void> {
  const rawLimit = event?.data?.limit;
  const limit = Math.min(Math.max(1, Number.isInteger(rawLimit) ? Number(rawLimit) : 50), 500);
  const result = await dispatchDomainOutboxBatch(limit, "domain-maintenance-sweeper");
  console.log("[DOMAIN MAINTENANCE]", JSON.stringify(result));
}
