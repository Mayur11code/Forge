import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { eventSchemas, EventType, EventPayloadMap } from "./schema";
import { db } from "@/lib/prisma/db";
import { analyticsWorkerHandler } from "@/app/api/worker/analytics-worker/route";
import { waitUntil } from "@vercel/functions";



// -----------------------------
// HANDLER TYPE
// -----------------------------
type WorkerHandler<K extends EventType> = (params: {
  event: {
    id: string;
    type: K;
    data: EventPayloadMap[K];
    time: string;
  };
}) => Promise<void>;

// -----------------------------
// CREATE WORKER
// -----------------------------
export function createWorker<K extends EventType>(
  eventType: K,
  handler: WorkerHandler<K>
) {
  // Define the internal logic
  const internalHandler = async (req: NextRequest) => {
    let messageId: string | null = null;

    try {
      const body = await req.json();
      const { id, type, data, time } = body;
      waitUntil(
        analyticsWorkerHandler({
          event: { id, type, data, time }
        })

      );
      messageId = req.headers.get("Upstash-Message-Id");

      if (!messageId) return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
      if (type !== eventType) return NextResponse.json({ error: "Invalid type" }, { status: 400 });

      const schema = eventSchemas[eventType];
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new Error(`Invalid payload for ${type}`);
      const validatedData = parsed.data as EventPayloadMap[K];


      // -----------------------------
      // 📊 UNIVERSAL ANALYTICS INTERCEPT
      // -----------------------------
      // We construct the "event" object your function expects.
      // Notice there is NO "await" here! It fires in the background.

      
      // ------------------------------------------------------
      // IDEMPOTENCY & STATE CHECK
      // ------------------------------------------------------
      let proceedToExecute = false;

      try {
        // Attempt to create the log (Atomic First-Time Check)
        await db.eventLog.create({
          data: {
            messageId,
            eventName: type,
            payload: validatedData as any,
            status: "PENDING",
          },
        });
        proceedToExecute = true; // It's the first time, proceed!
      } catch (error: any) {
        if (error.code === "P2002") {
          const existingLog = await db.eventLog.findUnique({
            where: { messageId },
            select: { status: true }
          });

          if (existingLog?.status === "SUCCESS") {
            return NextResponse.json({ ok: true, status: "already_processed" });
          }

          if (existingLog?.status === "PENDING") {
            return NextResponse.json({ ok: true, status: "already_running" });
          }

          if (existingLog?.status === "FAILED") {
            // Attempt to claim the retry (Atomic Update)
            const updated = await db.eventLog.updateMany({
              where: { messageId, status: "FAILED" },
              data: { status: "PENDING", error: null },
            });

            if (updated.count > 0) proceedToExecute = true;
          }
        } else {
          throw error; // Rethrow unknown DB errors
        }
      }

      // ------------------------------------------------------
      // EXECUTION
      // ------------------------------------------------------
      if (proceedToExecute) {
        try {
          await handler({
            event: { id, type, data: validatedData, time },
          });

          await db.eventLog.update({
            where: { messageId },
            data: { status: "SUCCESS" },
          });

          return NextResponse.json({ success: true });
        } catch (handlerError: any) {
          await db.eventLog.update({
            where: { messageId },
            data: {
              status: "FAILED",
              error: handlerError.message || "Unknown error",
            },
          });
          return NextResponse.json({ error: "Worker execution failed" }, { status: 500 });
        }
      }

      return NextResponse.json({ ok: true });

    } catch (error: any) {
      console.error("Critical Worker Error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  };

  // WRAP AND RETURN (This is where the signature check happens)
  return verifySignatureAppRouter(internalHandler);
}