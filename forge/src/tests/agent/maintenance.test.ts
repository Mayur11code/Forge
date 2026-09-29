// src/tests/agent/maintenance.test.ts
//
// The maintenance pass: that it actually performs the sweeps it claims to, that
// every sweep is bounded, and that a broken one does not take the rest down.
//
// The pass exists because all three recovery duties had zero callers. A handler
// that silently swallows a failing sweep would leave an orphaned execution
// hanging forever while looking healthy - the failure mode this whole pass exists
// to close.
//
// Authentication is deliberately NOT tested here. Maintenance is delivered as a
// QStash message to the shared /api/worker dispatcher, so it is authenticated by
// `verifySignatureAppRouter` exactly like every other job. A second auth scheme
// would be a second thing to get wrong, and `worker-auth.test.ts` already covers
// the real one.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));
jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/reaper", () => ({
  expireStaleApprovals: jest.fn(),
  reapOrphanedToolExecutions: jest.fn(),
  redeliverStalledConfirmedExecutions: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  dispatchOutboxBatch: jest.fn(),
}));

import {
  expireStaleApprovals,
  reapOrphanedToolExecutions,
  redeliverStalledConfirmedExecutions,
} from "@/lib/ai/agent/reaper";
import { dispatchOutboxBatch } from "@/lib/ai/agent/outbox";
import { AGENT_MAINTENANCE_BATCH_SIZE } from "@/lib/ai/agent/constants";
import { eventSchemas } from "@/lib/events/schema";
import {
  handleAgentMaintenance,
  runAgentMaintenance,
} from "@/app/api/worker/agent-maintenance/am";

const expireMock = expireStaleApprovals as jest.MockedFunction<
  typeof expireStaleApprovals
>;
const reapMock = reapOrphanedToolExecutions as jest.MockedFunction<
  typeof reapOrphanedToolExecutions
>;
const redeliverMock =
  redeliverStalledConfirmedExecutions as jest.MockedFunction<
    typeof redeliverStalledConfirmedExecutions
  >;
const dispatchMock = dispatchOutboxBatch as jest.MockedFunction<
  typeof dispatchOutboxBatch
>;

function event(limit?: number) {
  return {
    event: {
      id: "evt_1",
      type: "AGENT_MAINTENANCE_REQUESTED" as const,
      time: new Date(0).toISOString(),
      // The default exists in the schema, so a payload that omits `limit` is
      // still valid and the handler must not receive undefined.
      data: eventSchemas.AGENT_MAINTENANCE_REQUESTED.parse(
        limit === undefined ? {} : { limit },
      ),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  expireMock.mockResolvedValue({
    expired: 0,
    continued: 0,
    skipped: 0,
    scanned: 0,
    durationMs: 1,
    errors: [],
  });

  reapMock.mockResolvedValue({ swept: 0, sessionIds: [] });
  redeliverMock.mockResolvedValue([]);
  dispatchMock.mockResolvedValue({
    claimed: 0,
    published: 0,
    failed: 0,
    durationMs: 1,
  });
});

// ---------------------------------------------------------------------------
// Work performed
// ---------------------------------------------------------------------------

describe("work performed", () => {
  it("runs all four duties", async () => {
    await handleAgentMaintenance(event());

    expect(expireMock).toHaveBeenCalledTimes(1);
    expect(reapMock).toHaveBeenCalledTimes(1);
    expect(redeliverMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("drains the outbox as part of the same pass", async () => {
    // Without a dispatcher on a schedule, every recorded intent stays a row in
    // the database: deferred, not delivered. The outbox is the mechanism that
    // made the domain write atomic with the intent to act on it, and it is inert
    // without this.
    await handleAgentMaintenance(event());

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("reports counts for each duty", async () => {
    expireMock.mockResolvedValue({
      expired: 3,
      continued: 2,
      skipped: 1,
      scanned: 3,
      durationMs: 5,
      errors: [],
    });
    reapMock.mockResolvedValue({ swept: 1, sessionIds: ["sess_1"] });
    redeliverMock.mockResolvedValue(["exec_1"]);
    dispatchMock.mockResolvedValue({
      claimed: 4,
      published: 3,
      failed: 1,
      durationMs: 7,
    });

    const summary = await runAgentMaintenance();

    expect(summary.ok).toBe(true);
    expect(summary.expired).toMatchObject({ expired: 3, continued: 2 });
    expect(summary.orphaned).toMatchObject({ swept: 1 });
    expect(summary.redelivered).toEqual(["exec_1"]);
    expect(summary.outbox).toMatchObject({ claimed: 4, failed: 1 });
    expect(summary.errors).toEqual([]);
  });

  it("resolves void through the worker contract", async () => {
    // The dispatcher owns the HTTP response and types handlers as Promise<void>,
    // so the summary must not leak out of the worker entry point.
    await expect(handleAgentMaintenance(event())).resolves.toBeUndefined();
  });

  it("bounds every duty so a pass cannot scan an unbounded result set", async () => {
    await handleAgentMaintenance(event());

    // The sweeps take a named `limit`; the dispatcher takes it positionally.
    for (const mock of [expireMock, reapMock, redeliverMock]) {
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ limit: expect.any(Number) }),
      );
    }

    expect(dispatchMock).toHaveBeenCalledWith(expect.any(Number));
  });

  it("passes the scheduled limit through to every duty", async () => {
    await handleAgentMaintenance(event(7));

    for (const mock of [expireMock, reapMock, redeliverMock]) {
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
    }

    expect(dispatchMock).toHaveBeenCalledWith(7);
  });

  it("falls back to the batch constant when called without a limit", async () => {
    await runAgentMaintenance();

    for (const mock of [expireMock, reapMock, redeliverMock]) {
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ limit: AGENT_MAINTENANCE_BATCH_SIZE }),
      );
    }
  });

  it("does not let one failing duty stop the others", async () => {
    // A broken reaper must not also cost us the approval sweep, or a single
    // bad query would silently disable the rest of the recovery system.
    reapMock.mockRejectedValue(new Error("reaper exploded"));

    const summary = await runAgentMaintenance();

    expect(summary.ok).toBe(false);
    expect(summary.errors).toContainEqual(
      expect.stringContaining("reaper exploded"),
    );
    expect(expireMock).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalled();
  });

  it("names the failing duty so the log is diagnosable", async () => {
    expireMock.mockRejectedValue(new Error("boom"));
    redeliverMock.mockRejectedValue(new Error("bang"));

    const summary = await runAgentMaintenance();

    expect(summary.errors).toEqual([
      expect.stringContaining("expireStaleApprovals"),
      expect.stringContaining("redeliverStalledConfirmedExecutions"),
    ]);
  });

  it("reports a failing duty as null rather than a fabricated zero", async () => {
    // A `{swept: 0}` for a duty that threw would be a lie: it reads as "nothing
    // to do" when it means "we do not know".
    reapMock.mockRejectedValue(new Error("db down"));

    const summary = await runAgentMaintenance();

    expect(summary.orphaned).toBeNull();
    expect(summary.expired).not.toBeNull();
  });

  it("rejects when a duty fails, so the broker retries the tick", async () => {
    // The tick is the only thing driving this subsystem. Resolving normally would
    // let QStash record the delivery as successful while part of the sweep never
    // ran, which is indistinguishable from a working sweeper.
    dispatchMock.mockRejectedValue(new Error("qstash down"));

    await expect(handleAgentMaintenance(event())).rejects.toThrow(
      /dispatchOutboxBatch/,
    );
  });

  it("still runs the remaining duties before reporting a failure", async () => {
    // Throwing must not become a shortcut out of the sweep. If this ever failed,
    // the retry would be re-runnable but the first pass would have done nothing -
    // trading a five-minute delay for a completely skipped tick.
    dispatchMock.mockRejectedValue(new Error("qstash down"));

    await expect(handleAgentMaintenance(event())).rejects.toThrow();

    for (const mock of [expireMock, reapMock, redeliverMock, dispatchMock]) {
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it("names every failing duty in the thrown error", async () => {
    expireMock.mockRejectedValue(new Error("approval sweep down"));
    reapMock.mockRejectedValue(new Error("reaper down"));

    await expect(handleAgentMaintenance(event())).rejects.toThrow(
      /expireStaleApprovals[\s\S]*reapOrphanedToolExecutions/,
    );
  });
});

// ---------------------------------------------------------------------------
// Payload contract
// ---------------------------------------------------------------------------

describe("payload contract", () => {
  const schema = eventSchemas.AGENT_MAINTENANCE_REQUESTED;

  it("does not require an orgId, because the pass is system-wide", () => {
    // Maintenance sweeps every organization. Requiring `orgId` would mean
    // inventing a sentinel tenant and then filtering on it, which is how a
    // system-wide job quietly becomes a single-tenant one.
    expect(schema.safeParse({ limit: 10 }).success).toBe(true);
  });

  it("defaults the limit so a schedule body may omit it", () => {
    expect(schema.parse({})).toEqual({ limit: 100 });
  });

  it("rejects a limit that could turn a sweep into a full table scan", () => {
    for (const limit of [0, -1, 1001, 1.5, Number.NaN]) {
      expect(schema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("rejects unknown fields rather than ignoring them", () => {
    // A schedule body that misspells `limit` must not silently sweep with the
    // default while looking configured.
    expect(schema.safeParse({ limit: 10, limitt: 10 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe("logging", () => {
  it("logs counts and durations but no transcript", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      reapMock.mockResolvedValue({
        swept: 1,
        sessionIds: ["sess_secret_1"],
      });

      await runAgentMaintenance();

      const line = log.mock.calls.map((c) => c.join(" ")).join("\n");

      expect(line).toContain("AGENT MAINTENANCE");
      // Worker logs are shipped and broadly readable. A maintenance summary does
      // not need to carry session identifiers.
      expect(line).not.toContain("sess_secret_1");
    } finally {
      log.mockRestore();
    }
  });
});
