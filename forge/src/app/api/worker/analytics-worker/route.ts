import { createWorker } from "@/lib/events/worker";
import { db } from "@/lib/prisma/db";

export async function analyticsWorkerHandler({ event }: { event: any }) {
  // ❗ DO NOT filter — we want ALL events

  console.log("📊 ANALYTICS WORKER →", event.type);

  try {
    await db.analyticsEvent.create({
      data: {
        eventName: event.type,
        orgId: event.data?.orgId || null,
      },
    });
  } catch (error) {
    console.error("Analytics failed:", error);
    // do NOT throw → analytics should never break system
  }
};