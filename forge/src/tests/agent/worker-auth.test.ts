// src/tests/agent/worker-auth.test.ts
//
// Queue authenticity is not a function of NODE_ENV.
//
// The rule this file pins down: signature verification is the DEFAULT and
// applies everywhere. Disabling it requires an explicit, named opt-in that a
// deployed service has to deliberately set. NODE_ENV never influences the
// decision, because a deployed service carrying NODE_ENV=development must not
// silently accept forged requests to a handler that performs real writes.

// `lib/events/worker` reaches the database through `prisma/db` at module scope.
// Both prisma modules are mocked because `prisma/extended` imports
// `prisma/db`, so mocking only one still constructs a real PrismaClient, which
// next/jest would point at the live DATABASE_URL from .env.
// jest.setup-db-guard.ts turns that into an immediate failure.
//
// `prisma/db` gets a minimal inline double rather than the shared agent double:
// this file exercises the dispatcher's EventLog bookkeeping, and EventLog is not
// an agent model, so putting it on the shared double would be claiming a
// dependency that does not exist.
//
// `var` is deliberate - jest hoists jest.mock above the import requires, so an
// initialised const would still be in the temporal dead zone when the factory
// runs. The factory creates the object lazily for the same reason; the test body
// reads it back off the mocked module, which is the same instance.
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

// eslint-disable-next-line no-var
var eventLogDouble: {
  create: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
} | undefined;

jest.mock("@/lib/prisma/db", () => ({
  db: {
    eventLog: (eventLogDouble ??= {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    }),
    // The dispatcher calls the analytics worker on every delivery. It catches and
    // logs its own failures, so a missing model would not fail the test - it would
    // just fill the output with errors that look like real faults.
    analyticsEvent: { create: jest.fn() },
  },
}));

import { isUnsignedWorkerAllowed, createWorker } from "@/lib/events/worker";
import { db } from "@/lib/prisma/db";
import { NextRequest } from "next/server";

const eventLog = db.eventLog as unknown as {
  create: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
};

const ENV_KEY = "ALLOW_UNSIGNED_LOCAL_WORKER";

function withEnv(value: string | undefined, fn: () => void) {
  const original = process.env[ENV_KEY];

  try {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }

    fn();
  } finally {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  }
}

describe("isUnsignedWorkerAllowed", () => {
  it("is false when the opt-in is unset", () => {
    withEnv(undefined, () => {
      expect(isUnsignedWorkerAllowed()).toBe(false);
    });
  });

  it("is true only for the exact string 'true'", () => {
    withEnv("true", () => {
      expect(isUnsignedWorkerAllowed()).toBe(true);
    });
  });

  it.each([
    ["false", "an explicit false"],
    ["0", "a numeric zero"],
    ["1", "a truthy-looking one"],
    ["TRUE", "a differently-cased true"],
    ["yes", "an affirmative word"],
    ["", "an empty string"],
    [" true", "a padded value"],
  ])("is false for %s (%s)", (value) => {
    // Exact match on purpose. A truthiness check would treat "false" as true and
    // disable verification on a service that explicitly asked to keep it on -
    // the most dangerous possible reading of a security setting.
    withEnv(value, () => {
      expect(isUnsignedWorkerAllowed()).toBe(false);
    });
  });

  it("does not consult NODE_ENV", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalOptIn = process.env[ENV_KEY];

    // NODE_ENV is typed readonly by @types/node, so it is written through a
    // widened view rather than by suppressing the error.
    const env = process.env as Record<string, string | undefined>;

    try {
      // Even with a development-looking environment, verification stays on
      // unless the opt-in is explicitly present.
      env.NODE_ENV = "development";
      delete env[ENV_KEY];

      expect(isUnsignedWorkerAllowed()).toBe(false);

      env.NODE_ENV = "production";
      delete env[ENV_KEY];

      expect(isUnsignedWorkerAllowed()).toBe(false);
    } finally {
      if (originalNodeEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = originalNodeEnv;
      }

      if (originalOptIn === undefined) {
        delete env[ENV_KEY];
      } else {
        env[ENV_KEY] = originalOptIn;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduled deliveries
// ---------------------------------------------------------------------------

describe("scheduled deliveries", () => {
  // A QStash schedule replays one static body forever. Anything per-delivery
  // baked into that body - an id, a timestamp - would be a fabrication repeated on
  // every tick, so the dispatcher has to supply both from the real delivery.

  function deliver(body: Record<string, unknown>, messageId?: string) {
    const handler = jest.fn().mockResolvedValue(undefined);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (messageId) headers["upstash-message-id"] = messageId;

    // `createWorker` decides whether to wrap the handler in signature
    // verification at call time, reading the environment as it does so. The
    // opt-in is what makes this a direct call; the signed path is the default
    // and is what production uses.
    const original = process.env.ALLOW_UNSIGNED_LOCAL_WORKER;
    process.env.ALLOW_UNSIGNED_LOCAL_WORKER = "true";

    let route: (req: NextRequest) => Promise<Response>;

    try {
      route = createWorker("AGENT_MAINTENANCE_REQUESTED", handler);
    } finally {
      if (original === undefined) {
        delete process.env.ALLOW_UNSIGNED_LOCAL_WORKER;
      } else {
        process.env.ALLOW_UNSIGNED_LOCAL_WORKER = original;
      }
    }

    return route(
      new NextRequest("http://localhost/api/worker", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    ).then((res) => ({ res, handler }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    eventLog.create.mockResolvedValue({ messageId: "m" });
    eventLog.update.mockResolvedValue({});
  });

  it("derives a per-delivery id from the QStash message id", async () => {
    const { handler } = await deliver(
      { type: "AGENT_MAINTENANCE_REQUESTED", data: { limit: 10 } },
      "msg_tick_42",
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].event.id).toBe("msg_tick_42");
  });

  it("stamps a real arrival time when the schedule body omits one", async () => {
    const before = Date.now();

    const { handler } = await deliver(
      { type: "AGENT_MAINTENANCE_REQUESTED", data: { limit: 10 } },
      "msg_tick_42",
    );

    const { time } = handler.mock.calls[0][0].event;
    const stamped = Date.parse(time);

    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("prefers an explicit id so an outbox retry keeps its identity", async () => {
    // The outbox supplies a deterministic id. That must win over the message id,
    // otherwise a retry of the same logical event would look like a new one and
    // the dedup story would be false.
    const { handler } = await deliver(
      {
        id: "AGENT_LOOP_REQUESTED:sess_1",
        type: "AGENT_MAINTENANCE_REQUESTED",
        data: { limit: 10 },
        time: "2026-01-01T00:00:00.000Z",
      },
      "msg_tick_42",
    );

    expect(handler.mock.calls[0][0].event.id).toBe(
      "AGENT_LOOP_REQUESTED:sess_1",
    );
    expect(handler.mock.calls[0][0].event.time).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("rejects a schedule body that misspells the limit", async () => {
    // A silent fallback to the default here would produce a sweep that reads as
    // configured and is not, which is worse than a loud failure.
    const { res, handler } = await deliver(
      { type: "AGENT_MAINTENANCE_REQUESTED", data: { limitt: 10 } },
      "msg_tick_42",
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });

  it("requires a message id even for an otherwise valid schedule body", async () => {
    const { res, handler } = await deliver({
      type: "AGENT_MAINTENANCE_REQUESTED",
      data: { limit: 10 },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});

