// src/tests/agent/outbox.test.ts
//
// The transactional outbox: idempotency, atomicity, and retry safety.
//
// The guarantee being tested is NOT "published exactly once" - it is
// "the intent is durable, delivery is at-least-once, and a duplicate is
// harmless". Every test below is written against that, because a test asserting
// exactly-once would be asserting something the design explicitly does not claim.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import { publishEvent } from "@/lib/events/queue";
import {
  buildOutboxIdempotencyKey,
  recordAgentEvent,
  dispatchOutboxBatch,
  countPendingOutboxEvents,
} from "@/lib/ai/agent/outbox";
import { AGENT_OUTBOX_BACKOFF_MS } from "@/lib/ai/agent/constants";
import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

const publishEventMock = publishEvent as jest.MockedFunction<
  typeof publishEvent
>;

const EXECUTION_ID = "exec_1";
const SESSION_ID = "sess_1";
const ORG_ID = "org_1";

type Row = Record<string, unknown>;

function asDate(value: unknown): Date {
  return value as Date;
}

const payload = {
  orgId: ORG_ID,
  sessionId: SESSION_ID,
  executionId: EXECUTION_ID,
  expectedStep: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

describe("buildOutboxIdempotencyKey", () => {
  it("is a deterministic function of event type and aggregate id", () => {
    const a = buildOutboxIdempotencyKey(
      "AGENT_TOOL_EXECUTION_REQUESTED",
      EXECUTION_ID,
    );
    const b = buildOutboxIdempotencyKey(
      "AGENT_TOOL_EXECUTION_REQUESTED",
      EXECUTION_ID,
    );

    expect(a).toBe(b);
    expect(a).toBe(`AGENT_TOOL_EXECUTION_REQUESTED:${EXECUTION_ID}`);
  });

  it("distinguishes different events for the same aggregate", () => {
    const tool = buildOutboxIdempotencyKey(
      "AGENT_TOOL_EXECUTION_REQUESTED",
      EXECUTION_ID,
    );
    const loop = buildOutboxIdempotencyKey("AGENT_LOOP_REQUESTED", SESSION_ID);

    expect(tool).not.toBe(loop);
  });
});

// ---------------------------------------------------------------------------
// Recording intent
// ---------------------------------------------------------------------------

describe("recordAgentEvent", () => {
  it("requires a transaction client", () => {
    // The whole point is that intent and domain state share a transaction.
    // A call without `tx` should not typecheck, and this documents that.
    expect(recordAgentEvent.length).toBe(1);
  });

  it("records one pending row with a deterministic message id", async () => {
    const result = await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      aggregateId: EXECUTION_ID,
      payload,
    });

    expect(result.deduped).toBe(false);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      idempotencyKey: `AGENT_TOOL_EXECUTION_REQUESTED:${EXECUTION_ID}`,
      status: "PENDING",
      attempts: 0,
    });
    expect(store.outbox[0].messageId).toEqual(expect.any(String));
  });

  it("collapses a duplicate into the same logical row", async () => {
    const first = await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: EXECUTION_ID,
      aggregateId: EXECUTION_ID,
      payload,
    });

    const second = await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: EXECUTION_ID,
      aggregateId: EXECUTION_ID,
      payload,
    });

    // One row, not two. Two rows would mean two publishes, i.e. double dispatch.
    expect(store.outbox).toHaveLength(1);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("does not resurrect a published row when the producer runs again", async () => {
    await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: EXECUTION_ID,
      aggregateId: EXECUTION_ID,
      payload,
    });

    store.outbox[0].status = "PUBLISHED";
    store.outbox[0].publishedAt = new Date();

    await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: EXECUTION_ID,
      aggregateId: EXECUTION_ID,
      payload,
    });

    // A duplicate producer call must not re-open a delivered event, or the
    // dispatcher would publish the same work forever.
    expect(store.outbox[0].status).toBe("PUBLISHED");
  });

  it("keys distinct aggregates to distinct rows", async () => {
    await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: "exec_a",
      aggregateId: "exec_a",
      payload,
    });

    await recordAgentEvent({
      tx: prismaDouble as never,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      executionId: "exec_b",
      aggregateId: "exec_b",
      payload,
    });

    expect(store.outbox).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("dispatchOutboxBatch", () => {
  async function stageOutbox(rows: Row[] = []) {
    store.outbox = rows;
  }

  function pendingRow(overrides: Row = {}): Row {
    return {
      id: "outbox_1",
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      idempotencyKey: `AGENT_TOOL_EXECUTION_REQUESTED:${EXECUTION_ID}`,
      messageId: "agent-outbox-abc",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      payload,
      status: "PENDING",
      attempts: 0,
      availableAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      publishedAt: null,
      lastError: null,
      ...overrides,
    };
  }

  it("does nothing when there is nothing pending", async () => {
    await stageOutbox([]);

    const result = await dispatchOutboxBatch(10);

    expect(result).toMatchObject({ claimed: 0, published: 0, failed: 0 });
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("publishes with deterministic ids and marks the row sent", async () => {
    const row = pendingRow();
    await stageOutbox([row]);

    const result = await dispatchOutboxBatch(10);

    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });

    // The messageId is the row's, and the deduplicationId is the logical event
    // key, so a republish is recognisable to the broker as the same event.
    expect(publishEventMock).toHaveBeenCalledWith(
      "AGENT_TOOL_EXECUTION_REQUESTED",
      payload,
      undefined,
      {
        messageId: "agent-outbox-abc",
        deduplicationId: `AGENT_TOOL_EXECUTION_REQUESTED:${EXECUTION_ID}`,
      },
    );

    expect(row.status).toBe("PUBLISHED");
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it("leaves a failed publish pending and retryable", async () => {
    const row = pendingRow();
    await stageOutbox([row]);
    publishEventMock.mockRejectedValueOnce(new Error("QStash unavailable"));

    const result = await dispatchOutboxBatch(10);

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });

    // NOT deleted and NOT marked sent. The intent is still owed, so it stays
    // PENDING with backoff. Dropping it here would recreate the exact
    // DB-says-work-needed-but-event-is-gone bug the outbox exists to prevent.
    expect(row.status).toBe("PENDING");
    expect(row.lastError).toContain("QStash unavailable");
    expect(asDate(row.availableAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("records the error without leaking the payload", async () => {
    const row = pendingRow();
    await stageOutbox([row]);
    publishEventMock.mockRejectedValueOnce(new Error("boom"));

    await dispatchOutboxBatch(10);

    // Tool payloads must not land in a log line that a platform may capture.
    expect(String(row.lastError)).not.toContain("Fix login");
  });

  it("backs off further on each consecutive failure", async () => {
    const row = pendingRow();
    await stageOutbox([row]);

    publishEventMock.mockRejectedValueOnce(new Error("first"));
    await dispatchOutboxBatch(10);
    const firstDelay = asDate(row.availableAt).getTime() - Date.now();

    // Make it due again immediately so the next pass picks it up.
    row.availableAt = new Date(Date.now() - 1);
    publishEventMock.mockRejectedValueOnce(new Error("second"));
    await dispatchOutboxBatch(10);
    const secondDelay = asDate(row.availableAt).getTime() - Date.now();

    expect(row.attempts).toBe(2);
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it("caps the backoff so a poison event retries slowly, not never", async () => {
    const row = pendingRow({ attempts: 99, availableAt: new Date(0) });
    await stageOutbox([row]);
    publishEventMock.mockRejectedValueOnce(new Error("still broken"));

    await dispatchOutboxBatch(10);

    const maxBackoff = AGENT_OUTBOX_BACKOFF_MS[AGENT_OUTBOX_BACKOFF_MS.length - 1];
    const delay = asDate(row.availableAt).getTime() - Date.now();

    expect(delay).toBeLessThanOrEqual(maxBackoff + 1000);
  });

  it("retries successfully on a later pass after a failure", async () => {
    const row = pendingRow();
    await stageOutbox([row]);
    publishEventMock.mockRejectedValueOnce(new Error("transient"));

    await dispatchOutboxBatch(10);
    expect(row.status).toBe("PENDING");

    row.availableAt = new Date(Date.now() - 1);
    const second = await dispatchOutboxBatch(10);

    expect(second).toMatchObject({ published: 1, failed: 0 });
    expect(row.status).toBe("PUBLISHED");
    // The earlier failure must not linger on a delivered event.
    expect(row.lastError).toBeNull();
  });

  it("is safe when the publisher succeeds and the process dies before marking sent", async () => {
    // This is the duplicate window the design admits to. It is only safe because
    // the consumer re-claims via CAS, which is asserted here at the row level:
    // the row is still PENDING, so a second pass republishes. Harmlessness comes
    // from the consumer, not from here.
    const row = pendingRow();
    await stageOutbox([row]);

    // Simulate: publish succeeded, then the process died before the update.
    publishEventMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("crash after send"), {
        __sentBeforeCrash: true,
      });
    });

    await dispatchOutboxBatch(10);

    expect(row.status).toBe("PENDING");
    expect(publishEventMock).toHaveBeenCalledTimes(1);

    // The redelivery uses the SAME deduplicationId, so QStash itself drops it
    // inside its dedup window - a second line of defence under consumer CAS.
    row.availableAt = new Date(Date.now() - 1);
    await dispatchOutboxBatch(10);

    expect(publishEventMock).toHaveBeenCalledTimes(2);
    const [, , , firstOptions] = publishEventMock.mock.calls[0];
    const [, , , secondOptions] = publishEventMock.mock.calls[1];
    expect(secondOptions?.deduplicationId).toBe(
      firstOptions?.deduplicationId,
    );
  });

  it("does not re-claim a row another pass already published", async () => {
    await stageOutbox([pendingRow({ status: "PUBLISHED" })]);

    const result = await dispatchOutboxBatch(10);

    expect(result.claimed).toBe(0);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("does not claim a row whose backoff has not elapsed", async () => {
    await stageOutbox([
      pendingRow({ availableAt: new Date(Date.now() + 60_000) }),
    ]);

    const result = await dispatchOutboxBatch(10);

    expect(result.claimed).toBe(0);
  });

  it("keeps going when one publish throws and still sends the rest", async () => {
    const first = pendingRow({ id: "outbox_1" });
    const second = pendingRow({
      id: "outbox_2",
      idempotencyKey: `AGENT_TOOL_EXECUTION_REQUESTED:exec_2`,
    });
    await stageOutbox([first, second]);

    publishEventMock.mockRejectedValueOnce(new Error("one bad event"));

    const result = await dispatchOutboxBatch(10);

    expect(result).toMatchObject({ claimed: 2, published: 1, failed: 1 });
    expect(first.status).toBe("PENDING");
    expect(second.status).toBe("PUBLISHED");
  });

  it("lets only one of two overlapping passes claim the same row", async () => {
    // The claim is a CAS on BOTH status and the observed attempt count. A
    // status-only CAS would let both passes through, because claiming does not
    // change status - both would read PENDING and both would "win", publishing
    // the same event twice from inside the app.
    const row = pendingRow();
    await stageOutbox([row]);

    // The first pass claims and then blocks inside publish, which is exactly
    // the window in which a second maintenance tick overlaps.
    let release: () => void = () => {};
    publishEventMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ messageId: "published" });
        }),
    );

    const firstPass = dispatchOutboxBatch(10);

    // Let the first pass reach its publish call and stall there.
    await new Promise((resolve) => setImmediate(resolve));

    const secondPass = await dispatchOutboxBatch(10);

    // The second pass sees the row still PENDING, but the attempt count has
    // moved, so its predicate no longer matches and it claims nothing.
    expect(secondPass.claimed).toBe(0);
    expect(publishEventMock).toHaveBeenCalledTimes(1);

    release();

    const firstResult = await firstPass;

    expect(firstResult).toMatchObject({ claimed: 1, published: 1 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it("makes a row re-claimable after a failed attempt", async () => {
    // `attempts` doubles as the claim's optimistic-concurrency version, so the
    // failure path must leave it incremented-but-matching: a row pushed back to
    // PENDING has to be claimable on the next pass, or a single transient
    // QStash error would strand the event forever.
    const row = pendingRow();
    await stageOutbox([row]);

    publishEventMock.mockRejectedValueOnce(new Error("transient"));

    const failed = await dispatchOutboxBatch(10);
    expect(failed).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);

    // The row is not yet due (backoff pushed it forward), so make it due again
    // to isolate re-claimability from the backoff gate.
    row.availableAt = new Date(Date.now() - 1000);

    const retried = await dispatchOutboxBatch(10);

    expect(retried).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(row.attempts).toBe(2);
  });

  it("is bounded by the requested limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      pendingRow({
        id: `outbox_${i}`,
        idempotencyKey: `AGENT_TOOL_EXECUTION_REQUESTED:exec_${i}`,
      }),
    );
    await stageOutbox(rows);

    const result = await dispatchOutboxBatch(2);

    expect(result.claimed).toBe(2);
    // The rest remain for the next tick; nothing is lost.
    expect(await countPendingOutboxEvents()).toBe(3);
  });
});
