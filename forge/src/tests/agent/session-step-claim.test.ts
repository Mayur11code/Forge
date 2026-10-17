// src/tests/agent/session-step-claim.test.ts
//
// Regression coverage for the durable step claim's compare-and-set.
//
// The agent loop only advances a session when the delivered event's expected
// step still matches the persisted `currentStep`; a stale or duplicate loop
// event must be a no-op. These cases drive the REAL `claimNextAgentStep` against
// the in-memory prisma double and assert that the double enforces the
// `currentStep` predicate instead of advancing a session for any expected step.
// The compare-and-set behaviour is deliberately NOT mocked away - doing so is
// exactly what would let these cases pass without exercising the CAS.

jest.mock("server-only", () => ({}));

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

import { claimNextAgentStep } from "@/lib/ai/agent/session-service";
import { resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";

const SESSION_ID = "sess_claim_a";
const OTHER_SESSION_ID = "sess_claim_b";

function seedSession(id: string, currentStep: number): void {
  store.sessions.push({
    id,
    orgId: "org_1",
    userId: "user_1",
    status: "RUNNING",
    currentStep,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    promptVersion: "v1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

function stepOf(id: string): unknown {
  return store.sessions.find((row) => row.id === id)?.currentStep;
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
  // Both sessions share the same current step, so an update that ignored the
  // `id` predicate would move the wrong one and an update that ignored the
  // `currentStep` predicate would move both.
  seedSession(SESSION_ID, 2);
  seedSession(OTHER_SESSION_ID, 2);
});

describe("claimNextAgentStep compare-and-set", () => {
  it("advances the intended session exactly once when the expected step matches", async () => {
    const claimed = await claimNextAgentStep(SESSION_ID, 2);

    expect(claimed).toBe(true);
    expect(stepOf(SESSION_ID)).toBe(3);
    expect(stepOf(OTHER_SESSION_ID)).toBe(2);
  });

  it("does not advance the session when the expected step is stale", async () => {
    const claimed = await claimNextAgentStep(SESSION_ID, 1);

    expect(claimed).toBe(false);
    expect(stepOf(SESSION_ID)).toBe(2);
    expect(stepOf(OTHER_SESSION_ID)).toBe(2);
  });

  it("does not accept a duplicate claim for an already-advanced step", async () => {
    const first = await claimNextAgentStep(SESSION_ID, 2);
    const duplicate = await claimNextAgentStep(SESSION_ID, 2);

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    // A second `increment` must not have landed: the step advanced once.
    expect(stepOf(SESSION_ID)).toBe(3);
  });

  it("leaves an unrelated session unchanged when another session is claimed", async () => {
    await claimNextAgentStep(SESSION_ID, 2);

    expect(stepOf(OTHER_SESSION_ID)).toBe(2);

    // The other session can still be claimed on its own expected step, so the
    // predicate scopes the update rather than blocking all claims.
    const claimedOther = await claimNextAgentStep(OTHER_SESSION_ID, 2);

    expect(claimedOther).toBe(true);
    expect(stepOf(SESSION_ID)).toBe(3);
    expect(stepOf(OTHER_SESSION_ID)).toBe(3);
  });

  it("does not advance the session when the claimed step is ahead of the expected step", async () => {
    const claimed = await claimNextAgentStep(SESSION_ID, 3);

    expect(claimed).toBe(false);
    expect(stepOf(SESSION_ID)).toBe(2);
  });
});
