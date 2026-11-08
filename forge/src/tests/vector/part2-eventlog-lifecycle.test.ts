// forge/src/tests/vector/part2-eventlog-lifecycle.test.ts
/**
 * Phase B Remediation — Part 2.1: EventLog Worker Lease Lifecycle Acceptance Tests (E2)
 *
 * Verifies all mandatory requirements from UPPR Rev 4 & Part 2.1:
 * 1. A handler running longer than one lease interval triggers recurring renewal.
 * 2. Successful renewal maintains ownership while the handler runs.
 * 3. Renewal failure prevents successful completion.
 * 4. A stale worker cannot complete another worker's claim after lease is stolen.
 * 5. A stale worker cannot overwrite another worker's failure/completion state.
 * 6. Heartbeat cleanup occurs after successful completion.
 * 7. Heartbeat cleanup occurs after handler exceptions.
 * 8. Heartbeat cleanup occurs after renewal failure.
 * 9. Concurrent renewals cannot produce incorrect ownership decisions.
 * 10. NULL lease expiration fails closed and is rejected as an active lease.
 * 11. Missing authoritative SQL interface fails closed for EventLog renewal.
 * 12. Missing authoritative SQL interface fails closed for EventLog success completion.
 * 13. Missing authoritative SQL interface fails closed for EventLog failure completion.
 */

jest.mock("server-only", () => ({}));
jest.mock("@/app/api/worker/analytics-worker/aw", () => ({
  analyticsWorkerHandler: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@vercel/functions", () => ({
  waitUntil: jest.fn((p) => p),
}));

import { createWorker, renewEventLogLease } from "@/lib/events/worker";
import { NextRequest } from "next/server";

interface EventLogRow {
  id: string;
  messageId: string;
  eventName: string;
  payload: any;
  status: "PENDING" | "SUCCESS" | "FAILED";
  claimToken: string;
  leaseExpiresAt: Date | null;
  outboxEventId: string | null;
  error?: string | null;
}

class MockEventLogDb {
  public rows = new Map<string, EventLogRow>();
  public renewalCalls: Array<{ claimToken: string; time: number }> = [];
  public forceRenewalFailure = false;
  public forceDbError = false;
  public disableExecuteRaw = false;

  public reset() {
    this.rows.clear();
    this.renewalCalls = [];
    this.forceRenewalFailure = false;
    this.forceDbError = false;
    this.disableExecuteRaw = false;
  }

  public eventLog = {
    updateMany: jest.fn(async ({ where, data }: { where: any; data: any }) => {
      let count = 0;
      for (const row of this.rows.values()) {
        const matchesToken = row.claimToken === where.claimToken;
        const matchesStatus = row.status === where.status;
        const matchesLease =
          row.leaseExpiresAt !== null &&
          row.leaseExpiresAt.getTime() > (where.leaseExpiresAt?.gt?.getTime() ?? Date.now());

        if (matchesToken && matchesStatus && matchesLease) {
          if (data.status) row.status = data.status;
          if (data.error !== undefined) row.error = data.error;
          if (data.leaseExpiresAt !== undefined) {
            row.leaseExpiresAt = data.leaseExpiresAt ? new Date(data.leaseExpiresAt) : null;
          }
          count++;
        }
      }
      return { count };
    }),
  };

  public $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
    if (this.forceDbError) throw new Error("DB_CONNECTION_ERROR");
    const sql = strings.join("?");

    // 1. Check completed outbox event
    if (sql.includes('SELECT "id" FROM "EventLog"') && sql.includes('"status" = \'SUCCESS\'')) {
      const outboxId = values[0];
      for (const row of this.rows.values()) {
        if (row.outboxEventId === outboxId && row.status === "SUCCESS") {
          return [{ id: row.id }];
        }
      }
      return [];
    }

    // 2. Insert new EventLog
    if (sql.includes('INSERT INTO "EventLog"')) {
      const [id, messageId, eventName, payloadStr, outboxEventId, claimToken, leaseSeconds] = [
        values[0],
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        values[6],
      ];

      // Check unique constraint on messageId
      for (const row of this.rows.values()) {
        if (row.messageId === messageId) {
          const err: any = new Error("Unique constraint failed on messageId");
          err.code = "P2002";
          throw err;
        }
      }

      const row: EventLogRow = {
        id,
        messageId,
        eventName,
        payload: JSON.parse(payloadStr),
        status: "PENDING",
        claimToken,
        leaseExpiresAt: new Date(Date.now() + (Number(leaseSeconds) || 300) * 1000),
        outboxEventId: outboxEventId || null,
      };
      this.rows.set(id, row);
      return [{ id }];
    }

    // 3. Existing logs query on conflict
    if (sql.includes('SELECT "id", "status", "leaseExpiresAt", "messageId" FROM "EventLog"')) {
      const messageId = values[0];
      for (const row of this.rows.values()) {
        if (row.messageId === messageId) {
          return [row];
        }
      }
      return [];
    }

    // 4. Steal expired lease
    if (sql.includes('UPDATE "EventLog"') && sql.includes('"leaseExpiresAt" <= clock_timestamp()')) {
      const [newClaimToken, leaseSeconds, id] = [values[0], values[1], values[2]];
      const row = this.rows.get(id);
      if (
        row &&
        row.status === "PENDING" &&
        (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= Date.now())
      ) {
        row.claimToken = newClaimToken;
        row.leaseExpiresAt = new Date(Date.now() + (Number(leaseSeconds) || 300) * 1000);
        return [{ id: row.id }];
      }
      return [];
    }

    return [];
  });

  public $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
    if (this.disableExecuteRaw) {
      throw new Error("RAW_SQL_DISABLED_FOR_TEST");
    }
    if (this.forceDbError) throw new Error("DB_CONNECTION_ERROR");
    const sql = strings.join("?");

    // Renewal: UPDATE "EventLog" SET "leaseExpiresAt" = ... WHERE "claimToken" = ... AND "status" = 'PENDING' AND "leaseExpiresAt" > clock_timestamp()
    if (sql.includes('"leaseExpiresAt" = clock_timestamp()') && sql.includes('"claimToken" = ?')) {
      const extSecs = Number(values[0]) || 300;
      const claimToken = values[1];
      this.renewalCalls.push({ claimToken, time: Date.now() });

      if (this.forceRenewalFailure) {
        return 0; // Failed closed: ownership lost or row modified
      }

      for (const row of this.rows.values()) {
        if (row.claimToken === claimToken && row.status === "PENDING") {
          // If expired or null, fail closed
          if (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= Date.now()) {
            return 0;
          }
          row.leaseExpiresAt = new Date(Date.now() + extSecs * 1000);
          return 1;
        }
      }
      return 0;
    }

    // Fenced SUCCESS update: WHERE "claimToken" = ... AND "status" = 'PENDING' AND "leaseExpiresAt" > clock_timestamp()
    if (sql.includes('"status" = \'SUCCESS\'::"EventStatus"') && sql.includes('"claimToken" = ?')) {
      const claimToken = values[0];
      for (const row of this.rows.values()) {
        if (row.claimToken === claimToken && row.status === "PENDING") {
          if (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= Date.now()) {
            return 0; // Lease expired or null, cannot mark success
          }
          row.status = "SUCCESS";
          row.leaseExpiresAt = null;
          return 1;
        }
      }
      return 0;
    }

    // Fenced FAILED update: WHERE "claimToken" = ... AND "status" = 'PENDING' AND "leaseExpiresAt" > clock_timestamp()
    if (sql.includes('"status" = \'FAILED\'::"EventStatus"') && sql.includes('"claimToken" = ?')) {
      const errMsg = values[0];
      const claimToken = values[1];
      for (const row of this.rows.values()) {
        if (row.claimToken === claimToken && row.status === "PENDING") {
          if (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= Date.now()) {
            return 0; // Stale worker cannot mark failed
          }
          row.status = "FAILED";
          row.error = errMsg;
          row.leaseExpiresAt = null;
          return 1;
        }
      }
      return 0;
    }

    return 0;
  });
}

// eslint-disable-next-line no-var
var mockDb: MockEventLogDb;

jest.mock("@/lib/prisma/db", () => ({
  db: new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "$executeRaw" && mockDb?.disableExecuteRaw) {
        return undefined; // Simulate database adapter without $executeRaw
      }
      return (mockDb as any)?.[prop];
    },
  }),
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: new Proxy({}, {
    get: (_target, prop) => {
      return (mockDb as any)?.[prop];
    },
  }),
}));

function createWorkerRequest(messageId: string, eventData: any = {}) {
  return new NextRequest("http://localhost/api/worker", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Upstash-Message-Id": messageId,
    },
    body: JSON.stringify({
      type: "EMBEDDING_REQUESTED",
      data: {
        orgId: "org_test_123",
        entityId: "task_test_456",
        type: "TASK",
        ...eventData,
      },
    }),
  });
}

describe("Part 2.1 Area A: EventLog Worker Lease Lifecycle & Fencing (E2)", () => {
  const originalEnv = process.env.ALLOW_UNSIGNED_LOCAL_WORKER;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    mockDb = new MockEventLogDb();
    process.env.ALLOW_UNSIGNED_LOCAL_WORKER = "true";
    (process.env as any).NODE_ENV = "test";
  });

  afterAll(() => {
    process.env.ALLOW_UNSIGNED_LOCAL_WORKER = originalEnv;
    (process.env as any).NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.reset();
  });

  // ---------------------------------------------------------------------------
  // Case 1: Recurring Renewal Triggered
  // ---------------------------------------------------------------------------
  it("A1: A handler running longer than one lease interval triggers recurring renewal", async () => {
    let handlerExecuted = false;

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 140));
        handlerExecuted = true;
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 30,
      }
    );

    const req = createWorkerRequest("msg_case_1");
    const res = await workerRoute(req);
    const json = await res.json();

    expect(handlerExecuted).toBe(true);
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    expect(mockDb.renewalCalls.length).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Case 2: Ownership Maintained Throughout Run
  // ---------------------------------------------------------------------------
  it("A2: Successful renewal maintains ownership while the handler runs", async () => {
    let expirationTimes: number[] = [];

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
        if (row?.leaseExpiresAt) expirationTimes.push(row.leaseExpiresAt.getTime());

        await new Promise((resolve) => setTimeout(resolve, 80));
        if (row?.leaseExpiresAt) expirationTimes.push(row.leaseExpiresAt.getTime());

        await new Promise((resolve) => setTimeout(resolve, 80));
        if (row?.leaseExpiresAt) expirationTimes.push(row.leaseExpiresAt.getTime());
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 30,
      }
    );

    const req = createWorkerRequest("msg_case_2");
    const res = await workerRoute(req);
    expect(res.status).toBe(200);

    expect(expirationTimes.length).toBe(3);
    expect(expirationTimes[1]).toBeGreaterThanOrEqual(expirationTimes[0]);
    expect(expirationTimes[2]).toBeGreaterThanOrEqual(expirationTimes[1]);

    const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
    expect(row.status).toBe("SUCCESS");
  });

  // ---------------------------------------------------------------------------
  // Case 3: Renewal Failure Prevents Successful Completion
  // ---------------------------------------------------------------------------
  it("A3: Renewal failure marks ownership as lost and prevents successful completion", async () => {
    let handlerFinished = false;

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        mockDb.forceRenewalFailure = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        handlerFinished = true;
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 30,
      }
    );

    const req = createWorkerRequest("msg_case_3");
    const res = await workerRoute(req);
    const json = await res.json();

    expect(handlerFinished).toBe(true);
    expect(res.status).toBe(409);
    expect(json.error).toBe("OWNERSHIP_LOST");

    const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
    expect(row.status).not.toBe("SUCCESS");
  });

  // ---------------------------------------------------------------------------
  // Case 4: Stale Worker Cannot Complete Another Worker's Claim
  // ---------------------------------------------------------------------------
  it("A4: A stale worker cannot complete another worker's claim after lease is stolen", async () => {
    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
        row.claimToken = "new_thief_worker_claim_token";
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      {
        leaseSeconds: 10,
        heartbeatIntervalMs: 200,
      }
    );

    const req = createWorkerRequest("msg_case_4");
    const res = await workerRoute(req);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe("OWNERSHIP_LOST");

    const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
    expect(row.claimToken).toBe("new_thief_worker_claim_token");
    expect(row.status).toBe("PENDING");
  });

  // ---------------------------------------------------------------------------
  // Case 5: Stale Worker Cannot Overwrite Another Worker's State on Failure
  // ---------------------------------------------------------------------------
  it("A5: A stale worker cannot overwrite another worker's failure/completion state", async () => {
    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
        row.claimToken = "worker_2_token";
        row.status = "SUCCESS";

        throw new Error("Worker 1 exploded after losing claim");
      },
      {
        leaseSeconds: 10,
        heartbeatIntervalMs: 200,
      }
    );

    const req = createWorkerRequest("msg_case_5");
    const res = await workerRoute(req);

    expect(res.status).toBe(409);
    const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
    expect(row.status).toBe("SUCCESS");
    expect(row.claimToken).toBe("worker_2_token");
  });

  // ---------------------------------------------------------------------------
  // Case 6: Heartbeat Cleanup Occurs After Successful Completion
  // ---------------------------------------------------------------------------
  it("A6: Heartbeat cleanup occurs after successful completion", async () => {
    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 20,
      }
    );

    const req = createWorkerRequest("msg_case_6");
    const res = await workerRoute(req);
    expect(res.status).toBe(200);

    const callCountAfterSuccess = mockDb.renewalCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockDb.renewalCalls.length).toBe(callCountAfterSuccess);
  });

  // ---------------------------------------------------------------------------
  // Case 7: Heartbeat Cleanup Occurs After Handler Exceptions
  // ---------------------------------------------------------------------------
  it("A7: Heartbeat cleanup occurs after handler exceptions", async () => {
    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error("Handler catastrophic failure");
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 15,
      }
    );

    const req = createWorkerRequest("msg_case_7");
    const res = await workerRoute(req);
    expect(res.status).toBe(500);

    const callCountAfterError = mockDb.renewalCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockDb.renewalCalls.length).toBe(callCountAfterError);
  });

  // ---------------------------------------------------------------------------
  // Case 8: Heartbeat Cleanup Occurs After Renewal Failure
  // ---------------------------------------------------------------------------
  it("A8: Heartbeat cleanup occurs immediately after renewal failure", async () => {
    mockDb.forceRenewalFailure = true;

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 20,
      }
    );

    const req = createWorkerRequest("msg_case_8");
    const res = await workerRoute(req);
    expect(res.status).toBe(409);

    expect(mockDb.renewalCalls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockDb.renewalCalls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Case 9: In-flight Renewal Mutex
  // ---------------------------------------------------------------------------
  it("A9: In-flight renewal mutex prevents overlapping concurrent renewal executions", async () => {
    let ongoingRenewalCount = 0;
    let maxConcurrentRenewals = 0;

    const originalExecuteRaw = mockDb.$executeRaw;
    mockDb.$executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      const isRenewal = sql.includes('"leaseExpiresAt" = clock_timestamp()');
      if (isRenewal) {
        ongoingRenewalCount++;
        if (ongoingRenewalCount > maxConcurrentRenewals) {
          maxConcurrentRenewals = ongoingRenewalCount;
        }
      }
      if (isRenewal) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      try {
        return await originalExecuteRaw(strings, ...values);
      } finally {
        if (isRenewal) {
          ongoingRenewalCount--;
        }
      }
    });

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      },
      {
        leaseSeconds: 2,
        heartbeatIntervalMs: 10,
      }
    );

    const req = createWorkerRequest("msg_case_9");
    const res = await workerRoute(req);
    expect(res.status).toBe(200);

    expect(maxConcurrentRenewals).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Case 10: NULL Lease Expiration Fails Closed
  // ---------------------------------------------------------------------------
  it("A10: NULL lease expiration fails closed and is rejected as an active lease", async () => {
    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        // Force lease expiration to NULL while worker is running
        const row = Array.from(mockDb.rows.values())[0] as EventLogRow;
        row.leaseExpiresAt = null;
      },
      {
        leaseSeconds: 10,
        heartbeatIntervalMs: 200,
      }
    );

    const req = createWorkerRequest("msg_case_10");
    const res = await workerRoute(req);

    // SQL predicate requires `leaseExpiresAt > clock_timestamp()`; NULL fails closed
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("OWNERSHIP_LOST");
  });

  // ---------------------------------------------------------------------------
  // Case 11: Missing Authoritative SQL Interface Fails Closed for Renewal
  // ---------------------------------------------------------------------------
  it("A11: Missing authoritative SQL interface fails closed for EventLog renewal", async () => {
    const nonSqlDb = {
      eventLog: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const res = await renewEventLogLease({
      claimToken: "claim_nosql_token",
      extensionSeconds: 60,
      dbClient: nonSqlDb,
    });

    // Authoritative SQL interface missing -> fails closed immediately
    expect(res.renewed).toBe(false);
    expect(nonSqlDb.eventLog.updateMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 12: Missing Authoritative SQL Interface Fails Closed for Success Completion
  // ---------------------------------------------------------------------------
  it("A12: Missing authoritative SQL interface fails closed for EventLog success completion", async () => {
    mockDb.disableExecuteRaw = true;

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        // Handler completes successfully
      },
      {
        leaseSeconds: 5,
        heartbeatIntervalMs: 200,
      }
    );

    const req = createWorkerRequest("msg_case_12");
    const res = await workerRoute(req);

    // Missing $executeRaw fails closed with 409 OWNERSHIP_LOST
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("OWNERSHIP_LOST");
  });

  // ---------------------------------------------------------------------------
  // Case 13: Missing Authoritative SQL Interface Fails Closed for Failure Completion
  // ---------------------------------------------------------------------------
  it("A13: Missing authoritative SQL interface fails closed for EventLog failure completion", async () => {
    mockDb.disableExecuteRaw = true;

    const workerRoute = createWorker(
      "EMBEDDING_REQUESTED",
      async () => {
        throw new Error("Simulated worker internal failure");
      },
      {
        leaseSeconds: 5,
        heartbeatIntervalMs: 200,
      }
    );

    const req = createWorkerRequest("msg_case_13");
    const res = await workerRoute(req);

    // Missing $executeRaw fails closed with 409 OWNERSHIP_LOST instead of attempting unfenced ORM update
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("OWNERSHIP_LOST");
  });
});
