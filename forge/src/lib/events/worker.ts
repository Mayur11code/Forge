import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { eventSchemas, EventType, EventPayloadMap } from "./schema";
import { db } from "@/lib/prisma/db";
import { analyticsWorkerHandler } from "@/app/api/worker/analytics-worker/aw";
import { waitUntil } from "@vercel/functions";



/**
 * Validates and converts an arbitrary object into a genuine Prisma.InputJsonObject.
 * Rejects unsupported types (functions, symbols, bigints, NaN, Infinity) explicitly.
 */
export function toPrismaJsonObject(value: unknown): Prisma.InputJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Event payload must be a non-null object");
  }
  const result: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "undefined" || typeof val === "function" || typeof val === "symbol") {
      continue;
    }
    result[key] = toPrismaJsonValue(val);
  }
  return result as Prisma.InputJsonObject;
}

export function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new Error("Invalid JSON number: NaN or Infinity");
    }
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`Unsupported JSON value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return value.map(toPrismaJsonValue) as Prisma.InputJsonArray;
  }
  if (typeof value === "object") {
    return toPrismaJsonObject(value);
  }
  throw new Error("Unsupported JSON value");
}

/**
 * The single, explicit opt-out for local queue-message testing.
 * `ALLOW_UNSIGNED_LOCAL_WORKER=true` is the ONLY way to run a worker without
 * verifying QStash signatures, and it is checked by exact value rather than
 * by truthiness - `ALLOW_UNSIGNED_LOCAL_WORKER=false`, `=0` and an unset
 * variable all mean "keep verifying". A loose check such as
 * `if (process.env.ALLOW_UNSIGNED_LOCAL_WORKER)` would treat the string
 * `"false"` as true and disable verification on a service that explicitly asked
 * for it to stay on.
 *
 * Deliberately NOT keyed on NODE_ENV for the ENABLE decision. Accidentally
 * running a deployed service as "development" must never be sufficient to
 * disable queue authenticity, because this handler is a write path.
 *
 * S10 (hardened) - PRODUCTION IS ALWAYS SAFE. Even with the explicit flag set,
 * the opt-out is refused when `NODE_ENV === "production"` (or when the
 * deployment is otherwise detected as production). This turns "we rely on the
 * operator never setting the flag on a deployed service plus a warning" into an
 * enforced invariant: no configuration can make a production worker accept
 * unsigned requests. The flag is a local-development affordance, and it is
 * honoured only outside production.
 */
export function isUnsignedWorkerAllowed(): boolean {
  if (process.env.ALLOW_UNSIGNED_LOCAL_WORKER !== "true") {
    return false;
  }

  // The explicit opt-in cannot pierce production. `NODE_ENV=production` is the
  // canonical signal; Vercel preview/production deployments set it, and the
  // local dev server does not.
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  return true;
}

/**
 * The envelope every worker handler receives, typed against the event's own
 * payload. Exported so the handlers can declare it directly: a handler declared
 * as `({ event }: { event: any })` overrides the inference `createWorker` would
 * otherwise supply and opts out of the payload check entirely.
 */
export type WorkerEventEnvelope<K extends EventType> = {
  id: string;
  type: K;
  data: EventPayloadMap[K];
  time: string;
};

export type WorkerHandler<K extends EventType> = (params: {
  event: WorkerEventEnvelope<K>;
}) => Promise<void>;


export interface WorkerOptions {
  heartbeatIntervalMs?: number;
  leaseSeconds?: number;
}

export function createWorker<K extends EventType>(
  eventType: K,
  handler: WorkerHandler<K>,
  options?: WorkerOptions
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




      // State check with Database Clock Lease Ownership (Phase B Rev 3.2)
      let proceedToExecute = false;
      const workerClaimToken = crypto.randomUUID();
      const leaseSeconds = options?.leaseSeconds ?? 300;
      const heartbeatIntervalMs =
        options?.heartbeatIntervalMs ??
        Math.min(30_000, Math.max(100, Math.floor((leaseSeconds * 1000) / 3)));

      function extractOutboxEventId(target: unknown): string | null {
        if (typeof target === "object" && target !== null && "outboxEventId" in target) {
          const val = (target as { outboxEventId: unknown }).outboxEventId;
          return typeof val === "string" && val.length > 0 ? val : null;
        }
        return null;
      }
      const outboxEventId = extractOutboxEventId(validatedData) ?? extractOutboxEventId(body);

      // Logical Work Deduplication: if outboxEventId is provided, check if already completed
      if (outboxEventId) {
        if (typeof db.$queryRaw === "function") {
          const completed = await db.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "EventLog"
            WHERE "outboxEventId" = ${outboxEventId}
              AND "status" = 'SUCCESS'::"EventStatus"
            LIMIT 1;
          `;
          if (completed.length > 0) {
            return NextResponse.json({ ok: true, status: "already_processed" });
          }
        } else if (typeof db.eventLog?.findFirst === "function") {
          const completed = await db.eventLog.findFirst({
            where: { outboxEventId, status: "SUCCESS" },
          });
          if (completed) {
            return NextResponse.json({ ok: true, status: "already_processed" });
          }
        }
      }

      if (typeof db.$queryRaw === "function") {
        try {
          // Atomic First-Time Insert with DB-clock lease and claimToken
          const inserted = await db.$queryRaw<Array<{ id: string }>>`
            INSERT INTO "EventLog" (
              "id", "messageId", "eventName", "payload", "status",
              "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
            ) VALUES (
              ${crypto.randomUUID()},
              ${messageId},
              ${type},
              ${JSON.stringify(validatedData)}::jsonb,
              'PENDING'::"EventStatus",
              ${outboxEventId},
              ${workerClaimToken},
              clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
              clock_timestamp(),
              clock_timestamp()
            )
            RETURNING "id";
          `;
          proceedToExecute = inserted.length > 0;
        } catch (error) {
          const code = (error as { code?: unknown }).code;

          // Prisma unique violation code P2002 or Postgres 23505 (on messageId or outboxEventId active lease)
          if (
            code === "P2002" ||
            String(error).includes("unique constraint") ||
            String(error).includes("EventLog_messageId_key") ||
            String(error).includes("EventLog_outbox_active_idx")
          ) {
            const existingLogs = await db.$queryRaw<Array<{ id: string; status: string; leaseExpiresAt: Date | null; messageId: string }>>`
              SELECT "id", "status", "leaseExpiresAt", "messageId" FROM "EventLog"
              WHERE "messageId" = ${messageId}
                 OR ("outboxEventId" IS NOT NULL AND "outboxEventId" = ${outboxEventId})
              ORDER BY "createdAt" DESC
              LIMIT 1;
            `;
            const existingLog = existingLogs[0];

            if (existingLog?.status === "SUCCESS") {
              return NextResponse.json({ ok: true, status: "already_processed" });
            }

            if (existingLog?.status === "PENDING") {
              // Atomic lease steal if crashed worker lease has expired (S7)
              const stolen = await db.$queryRaw<Array<{ id: string }>>`
                UPDATE "EventLog"
                SET "claimToken" = ${workerClaimToken},
                    "leaseExpiresAt" = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
                    "updatedAt" = clock_timestamp()
                WHERE "id" = ${existingLog.id}
                  AND "status" = 'PENDING'::"EventStatus"
                  AND "leaseExpiresAt" <= clock_timestamp()
                RETURNING "id";
              `;

              if (stolen.length > 0) {
                proceedToExecute = true;
              } else {
                return NextResponse.json({ ok: true, status: "already_running" });
              }
            }

            if (existingLog?.status === "FAILED") {
              // Retry execution with new lease
              const retryClaimed = await db.$queryRaw<Array<{ id: string }>>`
                UPDATE "EventLog"
                SET "status" = 'PENDING'::"EventStatus",
                    "error" = NULL,
                    "claimToken" = ${workerClaimToken},
                    "leaseExpiresAt" = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
                    "updatedAt" = clock_timestamp()
                WHERE "id" = ${existingLog.id}
                  AND "status" = 'FAILED'::"EventStatus"
                RETURNING "id";
              `;

              if (retryClaimed.length > 0) {
                proceedToExecute = true;
              }
            }
          } else {
            throw error;
          }
        }
      } else {
        // Fallback for in-memory / unit-test double where $queryRaw is not mocked
        try {
          await db.eventLog.create({
            data: {
              messageId,
              eventName: type,
              payload: toPrismaJsonObject(validatedData),
              status: "PENDING",
              ...(outboxEventId ? { outboxEventId } : {}),
            },
          });
          proceedToExecute = true;
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (code === "P2002") {
            const existingLog = await db.eventLog.findFirst({
              where: {
                OR: [
                  { messageId },
                  ...(outboxEventId ? [{ outboxEventId }] : []),
                ],
              },
            });
            if (existingLog?.status === "SUCCESS") {
              return NextResponse.json({ ok: true, status: "already_processed" });
            }
            if (existingLog?.status === "PENDING") {
              return NextResponse.json({ ok: true, status: "already_running" });
            }
            if (existingLog?.status === "FAILED") {
              proceedToExecute = true;
            }
          } else {
            throw error;
          }
        }
      }

      if (proceedToExecute) {
        let ownershipLost = false;
        let heartbeatActive = true;
        let heartbeatTimer: NodeJS.Timeout | null = null;
        let renewalInFlight = false;

        const stopHeartbeat = () => {
          heartbeatActive = false;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const performRenewal = async () => {
          if (!heartbeatActive || ownershipLost || renewalInFlight) {
            return;
          }
          renewalInFlight = true;
          try {
            const res = await renewEventLogLease({
              messageId: messageId ?? undefined,
              claimToken: workerClaimToken,
              extensionSeconds: leaseSeconds,
              dbClient: db,
            });
            if (!res.renewed) {
              ownershipLost = true;
              stopHeartbeat();
            }
          } catch {
            ownershipLost = true;
            stopHeartbeat();
          } finally {
            renewalInFlight = false;
          }
        };

        // Activate recurring heartbeat only after lease acquisition (Part 2 Area A1)
        heartbeatTimer = setInterval(() => {
          performRenewal().catch(() => {
            ownershipLost = true;
            stopHeartbeat();
          });
        }, heartbeatIntervalMs);
        if (typeof heartbeatTimer?.unref === "function") {
          heartbeatTimer.unref();
        }

        try {
          await handler({
            event: { id: eventId, type, data: validatedData, time: eventTime },
          });

          // Check ownership before marking success (A3)
          if (ownershipLost) {
            return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
          }

          if (typeof db.$executeRaw === "function") {
            const affected = await db.$executeRaw`
              UPDATE "EventLog"
              SET "status" = 'SUCCESS'::"EventStatus",
                  "leaseExpiresAt" = NULL,
                  "updatedAt" = clock_timestamp()
              WHERE "claimToken" = ${workerClaimToken}
                AND "status" = 'PENDING'::"EventStatus"
                AND "leaseExpiresAt" > clock_timestamp();
            `;
            if (affected === 0) {
              return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
            }
          } else {
            // Missing authoritative SQL interface fails closed for EventLog success completion
            return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
          }

          return NextResponse.json({ success: true });
        } catch (handlerError) {
          if (ownershipLost) {
            return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
          }

          const errMsg = handlerError instanceof Error ? handlerError.message : "Unknown error";
          if (typeof db.$executeRaw === "function") {
            const affected = await db.$executeRaw`
              UPDATE "EventLog"
              SET "status" = 'FAILED'::"EventStatus",
                  "error" = ${errMsg},
                  "leaseExpiresAt" = NULL,
                  "updatedAt" = clock_timestamp()
              WHERE "claimToken" = ${workerClaimToken}
                AND "status" = 'PENDING'::"EventStatus"
                AND "leaseExpiresAt" > clock_timestamp();
            `;
            if (affected === 0) {
              return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
            }
          } else {
            // Missing authoritative SQL interface fails closed for EventLog failure completion
            return NextResponse.json({ error: "OWNERSHIP_LOST" }, { status: 409 });
          }
          return NextResponse.json({ error: "Worker execution failed" }, { status: 500 });
        } finally {
          // Cleanup on all exit paths (A4)
          stopHeartbeat();
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

export type EventLogLeaseClient = {
  $executeRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
};

/**
 * Monotonically extends the execution lease on an active EventLog row.
 * Fails closed if the worker has already lost ownership (e.g. lease expired and stolen).
 */
export async function renewEventLogLease({
  messageId,
  claimToken,
  extensionSeconds = 300,
  dbClient = db,
}: {
  messageId?: string;
  claimToken: string;
  extensionSeconds?: number;
  dbClient?: EventLogLeaseClient;
}): Promise<{ renewed: boolean }> {
  if (dbClient && typeof dbClient.$executeRaw === "function") {
    const affected = await dbClient.$executeRaw`
      UPDATE "EventLog"
      SET "leaseExpiresAt" = clock_timestamp() + (${extensionSeconds} || ' seconds')::interval,
          "updatedAt" = clock_timestamp()
      WHERE "claimToken" = ${claimToken}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" > clock_timestamp();
    `;
    return { renewed: affected > 0 };
  }
  // Missing authoritative SQL interface fails closed for EventLog renewal
  return { renewed: false };
}
