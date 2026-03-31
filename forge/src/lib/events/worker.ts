import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { eventSchemas, EventType, EventPayloadMap } from "./schema";
import { db } from "@/lib/prisma/db";




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
  async function internalHandler(req: NextRequest) {
    let messageId: string | null = null;

    try {
      const body = await req.json();

      // -----------------------------
      // PARSE CLOUD EVENT
      // -----------------------------
      const { id, type, data, time } = body;

      messageId = req.headers.get("Upstash-Message-Id");

      if (!messageId) {
        return NextResponse.json(
          { error: "Missing messageId" },
          { status: 400 }
        );
      }

      if (type !== eventType) {
        return NextResponse.json(
          { error: `Invalid event type. Expected ${eventType}` },
          { status: 400 }
        );
      }

      // -----------------------------
      // VALIDATE PAYLOAD
      // -----------------------------
      const schema = eventSchemas[eventType];
      const parsed = schema.safeParse(data);

      if (!parsed.success) {
        throw new Error(`Invalid payload for ${type}`);
      }

      const validatedData = parsed.data as EventPayloadMap[K];

      // -----------------------------
      // IDEMPOTENCY CHECK
      // -----------------------------
    //   const existing = await db.eventLog.findUnique({
    //     where: { messageId },
    //   });

    //   if (existing) {
    //     console.log(`⚠️ Duplicate event skipped: ${messageId}`);
    //     return NextResponse.json({ ok: true });
    //   }

    //   // -----------------------------
    //   // CREATE EVENT LOG (PENDING)
    //   // -----------------------------
    //   await db.eventLog.create({
    //     data: {
    //       messageId,
    //       eventName: type,
    //       payload: validatedData,
    //       status: "PENDING",
    //     },
    //   });
    //THIS IS NOT ATOMIC AND INTRODUCES RACE CON
    //   CONDITIONS. IN PRODUCTION, CONSIDER USING A SINGLE UPSERT QUERY OR A DISTRIBUTED LOCK.

 // -----------------------------
      // IDEMPOTENCY & STATE CHECK
      // -----------------------------
      try {
        // Attempt the atomic create first (Solves the Race Condition)
        await db.eventLog.create({
          data: {
            messageId,
            eventName: type,
            payload: validatedData,
            status: "PENDING",
          },
        });
      } catch (error: any) {
        if (error.code === "P2002") {
          // The record exists. Now we must check its STATUS.
          const existingLog = await db.eventLog.findUnique({
            where: { messageId },
            select: { status: true }
          });

          if (existingLog?.status === "SUCCESS") {
            console.log(`♻️ Already processed successfully: ${messageId}`);
            return NextResponse.json({ ok: true });
          }

          if (existingLog?.status === "PENDING") {
            console.log(`⚠️ Job currently running (Race condition dropped): ${messageId}`);
            return NextResponse.json({ ok: true });
          }

          if (existingLog?.status === "FAILED") {
            console.log(`🔄 Retrying previously failed job: ${messageId}`);
            // Reset the status back to PENDING so we can try again
            await db.eventLog.update({
              where: { messageId },
              data: { status: "PENDING", error: null },
            });
            // DO NOT RETURN HERE. Let the code continue down to execute the handler!
          }
        } else {
          // If it's not a P2002 error, the database is actually broken.
          throw error; 
        }
      }

      console.log("━━━━━━━━━━━━━━━━━━━━━━");
      console.log("⚙️ WORKER EXECUTION");
      console.log("Event:", type);
      console.log("Message ID:", messageId);
      console.log("━━━━━━━━━━━━━━━━━━━━━━");

      // -----------------------------
      // EXECUTE HANDLER
      // -----------------------------
      await handler({
        event: {
          id,
          type,
          data: validatedData,
          time,
        },
      });

      // -----------------------------
      // MARK SUCCESS
      // -----------------------------
      await db.eventLog.update({
        where: { messageId },
        data: { status: "SUCCESS" },
      });

      console.log(`✅ SUCCESS: ${messageId}`);

      return NextResponse.json({ success: true });

    } catch (error: any) {
      console.error("❌ WORKER ERROR:", error);

      if (messageId) {
        await db.eventLog.update({
          where: { messageId },
          data: {
            status: "FAILED",
            error: error.message || "Unknown error",
          },
        }).catch(() => {console.error("❌ Failed to update event log");});
      }

      return NextResponse.json({ error: "Worker failed" }, { status: 500 });
    }
  }

  // -----------------------------
  // WRAP WITH SIGNATURE VERIFICATION
  // -----------------------------
  return verifySignatureAppRouter(internalHandler);
}