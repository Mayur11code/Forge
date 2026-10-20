import type { WorkerHandler } from "@/lib/events/worker";

export const aiWorkerHandler: WorkerHandler<"EMBEDDING_REQUESTED"> = async ({
  event,
}) => {
  const { entityId, type } = event.data;

  // simulate AI work
  await new Promise((res) => setTimeout(res, 1000));
};


// PHASE 4 → REFACTOR TO USE WORKER FACTORY WITH
//  BUILT IN IDEMPOTENCY AND SCHEMA VALIDATION