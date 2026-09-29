import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { eventSchemas, EventType, EventPayloadMap } from "./schema";
import { db } from "@/lib/prisma/db";
import { analyticsWorkerHandler } from "@/app/api/worker/analytics-worker/aw";
import { waitUntil } from "@vercel/functions";



/**
 * The single, explicit opt-out for local queue-message testing.
 *
 * `ALLOW_UNSIGNED_LOCAL_WORKER=true` is the ONLY way to run a worker without
 * verifying QStash signatures, and it is checked by exact value rather than
 * by truthiness - `ALLOW_UNSIGNED_LOCAL_WORKER=false`, `=0` and an unset
 * variable all mean "keep verifying". A loose check such as
 * `if (process.env.ALLOW_UNSIGNED_LOCAL_WORKER)` would treat the string
 * `"false"` as true and disable verification on a service that explicitly asked
 * for it to stay on.
 *
 * Deliberately NOT keyed on NODE_ENV. Accidentally running a deployed service
 * as "development" must never be sufficient to disable queue authenticity,
 * because this handler is a write path.
 */
export function isUnsignedWorkerAllowed(): boolean {
  return process.env.ALLOW_UNSIGNED_LOCAL_WORKER === "true";
}

type WorkerHandler<K extends EventType> = (params: {
  event: {
    id: string;
    type: K;
    data: EventPayloadMap[K];
    time: string;
  };
}) => Promise<void>;


export function createWorker<K extends EventType>(
  eventType: K,
  handler: WorkerHandler<K>
) {

  const internalHandler = async (req: NextRequest) => {
    let messageId: string | null = null;

    try {
      const body = await req.json();
      const { type, data } = body;

      messageId = req.headers.get("Upstash-Message-Id");

      // Local-only convenience: mock the messageId so a hand-crafted request can
      // be exercised without QStash.
      //
      // Gated on an EXPLICIT, NAMED opt-in rather than NODE_ENV. NODE_ENV is
      // wrong here for a security-relevant decision: a deployed service that is
      // built or run with NODE_ENV=development (a preview deployment inheriting
      // local settings, a misconfigured container, a developer tunnel pointed at
      // production) would silently accept forged requests, and this handler is a
      // write path. The blast radius of that mistake is unauthenticated state
      // mutation, and it is invisible because everything "works".
      if (!messageId && isUnsignedWorkerAllowed()) {
        messageId = `local-mock-${Date.now()}`;
      }

      // CloudEvents `id` and `time` are required by spec, but a QStash SCHEDULE
      // body is a static template - whatever was written when the schedule was
      // created would be replayed verbatim on every tick, which is a fabricated
      // identity and a fabricated timestamp.
      //
      // So they are filled in per delivery: the QStash message id IS the true
      // per-delivery identity, and the arrival time is the only honest `time`.
      // The agent outbox still supplies its own deterministic `id`, which takes
      // precedence and is what makes a retry recognisably the same event.
      const eventId: string =
        typeof body.id === "string" && body.id.length > 0
          ? body.id
          : messageId ?? `unidentified-${Date.now()}`;

      const eventTime: string =
        typeof body.time === "string" && body.time.length > 0
          ? body.time
          : new Date().toISOString();

      waitUntil(
        analyticsWorkerHandler({
          event: { id: eventId, type, data, time: eventTime }
        })

      );

      if (!messageId) return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
      if (type !== eventType) return NextResponse.json({ error: "Invalid type" }, { status: 400 });

      const schema = eventSchemas[eventType];
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new Error(`Invalid payload for ${type}`);
      const validatedData = parsed.data as EventPayloadMap[K];




      //state check
      let proceedToExecute = false;

      try {
        // Attempt to create the log (Atomic First-Time Check)
        await db.eventLog.create({
          data: {
            messageId,
            eventName: type,
            // The validated payload is plain JSON at runtime; Prisma's
            // recursive Json type cannot express the inferred union, so the
            // cast goes through `InputJsonValue` rather than `any`.
            payload: validatedData as Prisma.InputJsonValue,
            status: "PENDING",
          },
        });
        proceedToExecute = true;
      } catch (error) {
        // Narrowed rather than typed `any`: only the Prisma unique-violation
        // code is meaningful here, and treating every throw as "has a .code"
        // would let an unrelated error masquerade as a duplicate.
        const code = (error as { code?: unknown }).code;

        if (code === "P2002") {
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
            // retry
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


      if (proceedToExecute) {
        try {
          await handler({
            event: { id: eventId, type, data: validatedData, time: eventTime },
          });

          await db.eventLog.update({
            where: { messageId },
            data: { status: "SUCCESS" },
          });

          return NextResponse.json({ success: true });
        } catch (handlerError) {
          await db.eventLog.update({
            where: { messageId },
            data: {
              status: "FAILED",
              error:
                handlerError instanceof Error
                  ? handlerError.message
                  : "Unknown error",
            },
          });
          return NextResponse.json({ error: "Worker execution failed" }, { status: 500 });
        }
      }

      return NextResponse.json({ ok: true });

    } catch (error) {
      console.error("Critical Worker Error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  };

// Signature enforcement is the DEFAULT and applies everywhere, including
  // `NODE_ENV=development`.
  //
  // The previous version inverted this: it skipped verification whenever
  // NODE_ENV was "development". That makes an environment NAME the security
  // boundary, which means any deployed or tunneled process that happens to carry
  // that value accepts unsigned requests, and a forged request reaches handlers
  // that perform real domain writes. The opt-in is now explicit and must be
  // deliberately set.
  if (isUnsignedWorkerAllowed()) {
    console.warn(
      "[WORKER] QStash signature verification DISABLED by " +
        "ALLOW_UNSIGNED_LOCAL_WORKER. Never set this on a deployed service.",
    );
    return internalHandler;
  }

  return verifySignatureAppRouter(internalHandler);
}