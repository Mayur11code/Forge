import { db } from "@/lib/prisma/db";
import type { EventType } from "@/lib/events/schema";

/**
 * The analytics worker is the one handler that runs BEFORE validation, by design:
 * `createWorker` calls it for every event so the log records what arrived even if
 * the payload turns out to be malformed. Its `data` is therefore genuinely
 * unknown-shaped rather than `EventPayloadMap[K]`, and `type` is any EventType.
 */
type UnvalidatedEvent = {
  id: string;
  type: EventType;
  data: Record<string, unknown> | undefined;
  time: string;
};

export async function analyticsWorkerHandler({
  event,
}: {
  event: UnvalidatedEvent;
}) {
  // ❗ DO NOT filter — we want ALL events

  console.log("📊 ANALYTICS WORKER →", event.type);

  try {
    // Narrowed rather than `|| null`: orgId is a string column, and a truthy
    // non-string arriving from an unvalidated payload would otherwise be handed
    // to Prisma as if it were already the right shape.
    const orgId =
      typeof event.data?.orgId === "string" ? event.data.orgId : null;

    await db.analyticsEvent.create({
      data: {
        eventName: event.type,
        orgId,
      },
    });
  } catch (error) {
    console.error("Analytics failed:", error);
    // do NOT throw → analytics should never break system
  }
};