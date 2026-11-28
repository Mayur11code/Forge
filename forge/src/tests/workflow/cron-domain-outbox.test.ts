/**
 * Test suite for M4-REM-3: Standing Production Outbox Sweeper Route Handler
 * (/api/cron/domain-outbox)
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/workflow/execution/event-dispatcher", () => ({
  processDomainEventOutbox: jest.fn().mockResolvedValue({
    processed: 2,
    successCount: 2,
    failureCount: 0,
  }),
}));

jest.mock("@/lib/events/domain-outbox", () => ({
  getDomainOutboxTelemetry: jest.fn().mockResolvedValue({
    pendingEligibleCount: 0,
    oldestPendingAgeSec: null,
    processingCount: 0,
    expiredLeaseCount: 0,
    deadLetterCount: 0,
    processedCount: 15,
    timestamp: new Date().toISOString(),
  }),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/cron/domain-outbox/route";
import { processDomainEventOutbox } from "@/lib/workflow/execution/event-dispatcher";

describe("M4-REM-3: /api/cron/domain-outbox Sweeper Route", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "test_secret_1234567890_abcdef" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects unauthorized request with 401 when CRON_SECRET is set and header is absent", async () => {
    const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(processDomainEventOutbox).not.toHaveBeenCalled();
  });

  it("rejects unauthorized request when token does not match", async () => {
    const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", {
      method: "GET",
      headers: {
        authorization: "Bearer wrong_secret_with_different_bytes",
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(processDomainEventOutbox).not.toHaveBeenCalled();
  });

  it("authorizes request with valid Bearer token and triggers processDomainEventOutbox", async () => {
    const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox?limit=15", {
      method: "GET",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
    expect(body.successCount).toBe(2);
    expect(body.failureCount).toBe(0);
    expect(body.telemetry).toBeDefined();
    expect(body.telemetry.processedCount).toBe(15);

    expect(processDomainEventOutbox).toHaveBeenCalledWith(15);
  });

  it("authorizes request with valid x-cron-secret header via POST", async () => {
    const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", {
      method: "POST",
      headers: {
        "x-cron-secret": process.env.CRON_SECRET!,
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(processDomainEventOutbox).toHaveBeenCalledWith(25);
  });
});
