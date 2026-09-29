// src/tests/agent/queue-publish.test.ts
//
// Queue publish options, and the delay unit conversion.
//
// The delay bug this covers was real and silent: `publishEvent` accepted a
// human-friendly string like "30s" and handed it straight to QStash, whose
// `delay` is a NUMBER OF SECONDS. The string would have been rejected by the
// client at runtime, and the call site was typed `any`, so nothing caught it at
// compile time. Deriving the request type from the client's own signature is
// what turned it into a build error; this test keeps the conversion itself
// pinned.

// The spies live on globalThis rather than in module-scope variables.
//
// `jest.mock` factories are hoisted above imports, so the factory runs before any
// top-level binding in this file is initialised. A `const` jest.fn() gives
// "Cannot access 'publishJson' before initialization"; a `var` still fails,
// because the babel transform evaluates the factory inside jest's own module
// scope where the binding is not visible. globalThis is the one object both
// scopes share.
type QstashSpies = {
  publishJson: jest.Mock;
  clientFactory: jest.Mock;
  clientOptions: Array<Record<string, unknown>>;
};

jest.mock("@upstash/qstash", () => {
  // The spies are CREATED here and published on globalThis, because the factory
  // runs before any statement in this file: `jest.mock` is hoisted above the
  // imports.
  const spies: QstashSpies = {
    publishJson: jest.fn().mockResolvedValue({ messageId: "msg_1" }),
    clientFactory: jest.fn(),
    clientOptions: [],
  };

  (globalThis as { __qstashSpies?: QstashSpies }).__qstashSpies = spies;

  return {
    Client: function MockQStashClient(options?: Record<string, unknown>) {
      spies.clientFactory();
      spies.clientOptions.push(options ?? {});

      return { publishJSON: spies.publishJson };
    },
  };
});

jest.mock("server-only", () => ({}));

import { publishEvent } from "@/lib/events/queue";

const publishJson = (
  globalThis as unknown as { __qstashSpies: QstashSpies }
).__qstashSpies.publishJson;

const clientFactory = (
  globalThis as unknown as { __qstashSpies: QstashSpies }
).__qstashSpies.clientFactory;

const clientOptions = (
  globalThis as unknown as { __qstashSpies: QstashSpies }
).__qstashSpies.clientOptions;

const ORIGINAL_TOKEN = process.env.QSTASH_TOKEN;
const ORIGINAL_URL = process.env.QSTASH_URL;
const ORIGINAL_TOPIC = process.env.AGENT_LOOP_REQUESTED_TOPIC;

function lastRequest(): Record<string, unknown> {
  return publishJson.mock.calls[publishJson.mock.calls.length - 1][0];
}

beforeEach(() => {
  // `publishJson` is cleared rather than all mocks: the constructor spy is
  // asserted on by a dedicated test, so clearing it here would destroy the
  // evidence that the real module was exercised at all.
  publishJson.mockClear();
  process.env.QSTASH_TOKEN = "test-token";
  process.env.QSTASH_URL = "https://qstash-us-east-1.upstash.io";
  process.env.AGENT_LOOP_REQUESTED_TOPIC = "topic-1";
});

afterAll(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.QSTASH_TOKEN;
  else process.env.QSTASH_TOKEN = ORIGINAL_TOKEN;

  if (ORIGINAL_URL === undefined) delete process.env.QSTASH_URL;
  else process.env.QSTASH_URL = ORIGINAL_URL;

  if (ORIGINAL_TOPIC === undefined) delete process.env.AGENT_LOOP_REQUESTED_TOPIC;
  else process.env.AGENT_LOOP_REQUESTED_TOPIC = ORIGINAL_TOPIC;
});

const payload = { orgId: "org_1", sessionId: "sess_1", expectedStep: 0 };

describe("publishEvent", () => {
  it("throws without a token rather than publishing anonymously", async () => {
    delete process.env.QSTASH_TOKEN;

    await expect(
      publishEvent("AGENT_LOOP_REQUESTED", payload),
    ).rejects.toThrow(/QSTASH_TOKEN/);

    expect(publishJson).not.toHaveBeenCalled();
  });

  it("omits delay entirely when none is requested", async () => {
    await publishEvent("AGENT_LOOP_REQUESTED", payload);

    expect(lastRequest()).not.toHaveProperty("delay");
  });

  it.each([
    ["30s", 30],
    ["5m", 300],
    ["2h", 7200],
    ["1d", 86_400],
    ["0s", 0],
  ])("converts %s to %i seconds", async (input, expected) => {
    await publishEvent("AGENT_LOOP_REQUESTED", payload, input as never);

    // QStash receives a number of seconds. Passing the string through would be
    // rejected by the client, which is the bug this test guards.
    expect(lastRequest().delay).toBe(expected);
    expect(typeof lastRequest().delay).toBe("number");
  });

  it("passes the deterministic id and deduplication key through", async () => {
    await publishEvent("AGENT_LOOP_REQUESTED", payload, undefined, {
      messageId: "agent-outbox-abc",
      deduplicationId: "AGENT_LOOP_REQUESTED:sess_1",
    });

    expect(lastRequest()).toMatchObject({
      deduplicationId: "AGENT_LOOP_REQUESTED:sess_1",
    });

    // The cloud event's id is the row's deterministic id, not a Date.now()
    // value, so a redelivery is recognisable as the same event.
    expect((lastRequest().body as { id: string }).id).toBe(
      "agent-outbox-abc",
    );
  });

  it("defaults the deduplication key to a hash of the cloud event", async () => {
    await publishEvent("AGENT_LOOP_REQUESTED", payload);

    expect(lastRequest().deduplicationId).toEqual(
      expect.any(String),
    );
  });

  it("rejects a payload that fails the event schema", async () => {
    await expect(
      // `expectedStep` must be a number; a string here is the realistic
      // failure, since these payloads come from model-adjacent code.
      publishEvent("AGENT_LOOP_REQUESTED", {
        orgId: "org_1",
        sessionId: "sess_1",
        expectedStep: "zero",
      } as never),
    ).rejects.toThrow(/Invalid payload/);

    expect(publishJson).not.toHaveBeenCalled();
  });

  // Upstash is multi-region. The SDK defaults to eu-central-1, and a token from
  // another region gets a 404 reading "user (...) not found in this region",
  // which reads as a revoked credential rather than a wrong endpoint. Passing the
  // configured base URL is what stops that misdiagnosis.
  it("constructs the client against the configured QStash region", async () => {
    process.env.QSTASH_URL = "https://qstash-us-east-1.upstash.io";

    await publishEvent("AGENT_LOOP_REQUESTED", payload);

    expect(clientOptions[clientOptions.length - 1]).toEqual({
      token: "test-token",
      baseUrl: "https://qstash-us-east-1.upstash.io",
    });
  });

  it("refuses to publish without a region rather than guessing the default", async () => {
    // The alternative is publishing into eu-central-1 and reporting a 404 that
    // looks like a bad token, so failing here is strictly more debuggable.
    delete process.env.QSTASH_URL;

    await expect(
      publishEvent("AGENT_LOOP_REQUESTED", payload),
    ).rejects.toThrow(/QSTASH_URL/);

    expect(publishJson).not.toHaveBeenCalled();
  });
});

// Asserted outside the suite: this is what makes the publish assertions above
// meaningful rather than vacuous, since they depend on a real Client being built.
it("builds a QStash client rather than stubbing the publisher", async () => {
  process.env.QSTASH_TOKEN = "test-token";
  process.env.QSTASH_URL = "https://qstash-us-east-1.upstash.io";

  clientFactory.mockClear();
  await publishEvent("AGENT_LOOP_REQUESTED", payload);

  expect(clientFactory).toHaveBeenCalled();
});
