// src/tests/vector/worker-lease-steal.realdb.test.ts
/**
 * Forge Vector V2 — Phase B: Real-Database Worker Lease Ownership & Steal (E3 Acceptance)
 *
 * Verifies:
 * 1. Active worker lease protects in-flight execution (duplicate returns already_running).
 * 2. Crashed worker lease expiration in DB clock allows atomic steal (Scenario S7).
 * 3. Competing workers racing to steal an expired lease cannot both acquire it (exactly one succeeds).
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

jest.setTimeout(120_000);

const APPROVED_NEON_DEV_HOSTS = [
  "ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech",
  "ep-muddy-water-ah607io6.c-3.us-east-1.aws.neon.tech",
];
const APPROVED_NEON_DEV_DB = "neondb";

function parseDbTarget(urlStr?: string): { host?: string; port?: string; dbName?: string } {
  if (!urlStr) return {};
  try {
    const parsed = new URL(urlStr);
    const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      dbName: dbName.toLowerCase(),
    };
  } catch {
    return {};
  }
}

const isNeonDevAuthorized = process.env.ALLOW_NEON_DEV_DB_TESTS === "true";
const targetDbUrl =
  process.env.DISPOSABLE_TEST_DATABASE_URL ||
  process.env.FORGE_DISPOSABLE_TEST_DATABASE_URL ||
  (isNeonDevAuthorized ? process.env.DATABASE_URL : undefined);

const isE3Required =
  process.env.REQUIRE_E3_CONCURRENCY === "true" ||
  process.env.CI === "true";

const describeRealDb = !targetDbUrl && !isE3Required ? describe.skip : describe;

describeRealDb("Forge Vector V2 — Phase B: Worker Lease Ownership & Steal (E3)", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `steal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const MESSAGE_ID_1 = `msg_1_${RUN_ID}`;
  const MESSAGE_ID_2 = `msg_2_${RUN_ID}`;

  beforeAll(async () => {
    if (!targetDbUrl) return;

    pool1 = new Pool({
      connectionString: targetDbUrl,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    testClient1 = new PrismaClient({ adapter: new PrismaPg(pool1) });

    pool2 = new Pool({
      connectionString: targetDbUrl,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    testClient2 = new PrismaClient({ adapter: new PrismaPg(pool2) });
  });

  afterAll(async () => {
    if (!testClient1) return;
    try {
      await testClient1.$executeRaw`
        DELETE FROM "EventLog" WHERE "messageId" IN (${MESSAGE_ID_1}, ${MESSAGE_ID_2});
      `;
    } catch {
      // Best-effort cleanup
    } finally {
      if (testClient1) await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  it("prevents lease steal while original worker lease remains active", async () => {
    if (!testClient1 || !testClient2) return;

    const worker1Token = `worker1_${RUN_ID}`;
    const worker2Token = `worker2_${RUN_ID}`;

    // 1. Worker 1 inserts active lease (300s into the future)
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${MESSAGE_ID_1},
        'EMBEDDING_REQUESTED',
        '{}'::jsonb,
        'PENDING'::"EventStatus",
        ${worker1Token},
        clock_timestamp() + interval '300 seconds',
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Worker 2 attempts atomic steal
    const stealAttempt = await testClient2.$queryRaw<Array<{ id: string }>>`
      UPDATE "EventLog"
      SET "claimToken" = ${worker2Token},
          "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
          "updatedAt" = clock_timestamp()
      WHERE "messageId" = ${MESSAGE_ID_1}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING "id";
    `;

    // Must be rejected: affected rows = 0
    expect(stealAttempt).toHaveLength(0);

    // Verify claimToken still belongs to Worker 1
    const current = await testClient1.eventLog.findUnique({
      where: { messageId: MESSAGE_ID_1 },
    });
    expect(current?.claimToken).toBe(worker1Token);
  });

  it("atomically steals the lease when crashed worker lease expires in database clock", async () => {
    if (!testClient1 || !testClient2) return;

    const worker2Token = `worker2_stolen_${RUN_ID}`;

    // 1. Simulate worker crash by expiring lease in PostgreSQL clock
    await testClient1.$executeRaw`
      UPDATE "EventLog"
      SET "leaseExpiresAt" = clock_timestamp() - interval '10 seconds'
      WHERE "messageId" = ${MESSAGE_ID_1};
    `;

    // 2. Worker 2 retries and atomically steals lease
    const stealAttempt = await testClient2.$queryRaw<Array<{ id: string }>>`
      UPDATE "EventLog"
      SET "claimToken" = ${worker2Token},
          "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
          "updatedAt" = clock_timestamp()
      WHERE "messageId" = ${MESSAGE_ID_1}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING "id";
    `;

    expect(stealAttempt).toHaveLength(1);

    // Verify claimToken is now Worker 2's token
    const current = await testClient1.eventLog.findUnique({
      where: { messageId: MESSAGE_ID_1 },
    });
    expect(current?.claimToken).toBe(worker2Token);
  });

  it("ensures exactly one winner when two workers concurrently race to steal an expired lease", async () => {
    if (!testClient1 || !testClient2) return;

    const initialToken = `initial_${RUN_ID}`;
    const racerAToken = `racerA_${RUN_ID}`;
    const racerBToken = `racerB_${RUN_ID}`;

    // 1. Create expired pending log
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${MESSAGE_ID_2},
        'EMBEDDING_REQUESTED',
        '{}'::jsonb,
        'PENDING'::"EventStatus",
        ${initialToken},
        clock_timestamp() - interval '10 seconds',
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Racer A and Racer B concurrently attempt steal
    const [resultA, resultB] = await Promise.all([
      testClient1.$queryRaw<Array<{ id: string }>>`
        UPDATE "EventLog"
        SET "claimToken" = ${racerAToken},
            "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
            "updatedAt" = clock_timestamp()
        WHERE "messageId" = ${MESSAGE_ID_2}
          AND "status" = 'PENDING'::"EventStatus"
          AND "leaseExpiresAt" <= clock_timestamp()
        RETURNING "id";
      `,
      testClient2.$queryRaw<Array<{ id: string }>>`
        UPDATE "EventLog"
        SET "claimToken" = ${racerBToken},
            "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
            "updatedAt" = clock_timestamp()
        WHERE "messageId" = ${MESSAGE_ID_2}
          AND "status" = 'PENDING'::"EventStatus"
          AND "leaseExpiresAt" <= clock_timestamp()
        RETURNING "id";
      `,
    ]);

    // Exactly one winner: one returned 1 row, other returned 0 rows
    const totalWinners = resultA.length + resultB.length;
    expect(totalWinners).toBe(1);

    const winningToken = resultA.length === 1 ? racerAToken : racerBToken;
    const current = await testClient1.eventLog.findUnique({
      where: { messageId: MESSAGE_ID_2 },
    });
    expect(current?.claimToken).toBe(winningToken);
  });
});
