// src/tests/agent/no-second-retry-controller.test.ts
//
// Assignment 37.14 — the loop is bounded by MAX_AGENT_STEPS and there is NO
// second retry controller.
//
// The phase explicitly forbids introducing a second retry controller, and its
// test gate names two properties:
//
//   1. a correctable failure re-enters the loop through the EXISTING
//      AGENT_LOOP_REQUESTED path, and is bounded by MAX_AGENT_STEPS;
//   2. session-status transitions (the 37.14 human-wait marker) never spin up a
//      new retry loop.
//
// This suite asserts the boundedness at its source (the pure step gate) and the
// single-controller property structurally: the only "attempt"-style machinery in
// the agent is outbox DELIVERY retry and the reaper's stalled-session re-drive
// cap, both of which re-drive an EXISTING event/row rather than running a
// parallel model-correction loop.

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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { decideStepGate, terminalReasonForToolCallDecision } from "@/lib/ai/agent/loop-policy";
import { MAX_AGENT_STEPS } from "@/lib/ai/agent/constants";
import {
  clearAgentSessionWaiting,
  markAgentSessionWaiting,
} from "@/lib/ai/agent/session-service";
import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

const SESSION_ID = "clxsessionnoretrycontroller";

function stageSession(status: string) {
  store.sessions.push({
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_1",
    status,
    currentStep: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

function sessionStatus(): string | undefined {
  return store.sessions.find((row) => row.id === SESSION_ID)?.status as
    | string
    | undefined;
}

beforeEach(() => {
  restorePrismaDouble();
  resetStore();
});

// ---------------------------------------------------------------------------
// Boundedness — the single step gate
// ---------------------------------------------------------------------------

describe("boundedness — MAX_AGENT_STEPS is the only model-turn budget", () => {
  it("runs exactly MAX_AGENT_STEPS model turns and stops the next one", () => {
    // 1-based, AFTER the durable claim: currentStep 1..N run, N+1 stops.
    for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
      expect(decideStepGate(step)).toEqual({ kind: "RUN" });
    }

    expect(decideStepGate(MAX_AGENT_STEPS + 1)).toEqual({
      kind: "STOP_MAX_STEPS",
      currentStep: MAX_AGENT_STEPS + 1,
      maxSteps: MAX_AGENT_STEPS,
    });
  });

  it("keeps the correction loop finite: a re-proposal is still one model turn", () => {
    // A structured INVALID_INPUT re-enters via AGENT_LOOP_REQUESTED, which claims
    // the next step. That claim passes through the SAME gate, so a self-correcting
    // session cannot exceed the budget no matter how many times it re-proposes.
    let step = 1;
    let turns = 0;
    while (decideStepGate(step).kind === "RUN") {
      turns += 1;
      step += 1;
    }

    expect(turns).toBe(MAX_AGENT_STEPS);
  });

  it("treats an over-budget turn as terminal, not as another retry", () => {
    const gate = decideStepGate(MAX_AGENT_STEPS + 1);
    expect(gate.kind).toBe("STOP_MAX_STEPS");

    // There is no decision value that means "retry the model turn". The gate is a
    // binary run/stop - the missing third state IS the missing retry controller.
    expect(Object.keys(gate).sort()).toEqual(["currentStep", "kind", "maxSteps"]);
    void terminalReasonForToolCallDecision;
  });
});

// ---------------------------------------------------------------------------
// No second controller — the only "attempt" machinery is delivery/re-drive
// ---------------------------------------------------------------------------

describe("no second retry controller", () => {
  const AGENT_DIR = join(__dirname, "..", "..", "lib", "ai", "agent");

  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        collectSourceFiles(full, acc);
      } else if (entry.endsWith(".ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  it("has no agent module that owns a retry/backoff loop over model turns", () => {
    // Symbols that would betray an unapproved retry controller living in the
    // agent. Delivery retry (outbox) and the stalled-session re-drive cap are
    // named separately below and are NOT model-turn loops.
    const forbidden = [
      /class\s+\w*RetryController/i,
      /function\s+\w*retryAgentStep/i,
      /function\s+\w*retryModelTurn/i,
      /new\s+\w*RetryController/i,
    ];

    const offenders: string[] = [];
    for (const file of collectSourceFiles(AGENT_DIR)) {
      const source = readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(source))) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("confines 'attempt' accounting to outbox delivery and the reaper re-drive cap", () => {
    const files = collectSourceFiles(AGENT_DIR);
    const attemptOwners = files
      .filter((file) => /\battempts\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/\\/g, "/").split("/lib/ai/agent/")[1]);

    // Exactly the sanctioned owners, and nothing that resembles a parallel
    // model-correction controller. `constants.ts` only declares the delivery
    // backoff schedule and the reaper's re-drive cap.
    expect(attemptOwners.sort()).toEqual([
      "constants.ts",
      "outbox.ts",
      "reaper.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Session-status transitions never spawn a retry loop
// ---------------------------------------------------------------------------

describe("session-status transitions do not create a new loop", () => {
  it("parking and clearing the human-wait marker is idempotent-only status CAS", async () => {
    stageSession("RUNNING");

    // Park: RUNNING -> WAITING_CONFIRMATION. This is a status transition with no
    // side channel - it does not enqueue anything.
    await markAgentSessionWaiting(SESSION_ID);
    expect(sessionStatus()).toBe("WAITING_CONFIRMATION");

    // A second park is a no-op (the CAS predicate no longer matches RUNNING).
    await markAgentSessionWaiting(SESSION_ID);
    expect(sessionStatus()).toBe("WAITING_CONFIRMATION");

    // Clear: WAITING_CONFIRMATION -> RUNNING. The continuation event is recorded
    // by the CALLER (the clarification service), never by the status transition.
    await clearAgentSessionWaiting(SESSION_ID);
    expect(sessionStatus()).toBe("RUNNING");

    // A second clear is a no-op (already RUNNING).
    await clearAgentSessionWaiting(SESSION_ID);
    expect(sessionStatus()).toBe("RUNNING");
  });

  it("clearing a session that never parked writes nothing", async () => {
    stageSession("RUNNING");

    await clearAgentSessionWaiting(SESSION_ID);

    expect(sessionStatus()).toBe("RUNNING");
  });

  it("does not enqueue an outbox event from the status CAS itself", async () => {
    stageSession("RUNNING");

    await markAgentSessionWaiting(SESSION_ID);
    await clearAgentSessionWaiting(SESSION_ID);

    // The wait CAS is pure status: it must not manufacture loop events, which
    // would be the seed of a second controller.
    expect(store.outbox).toHaveLength(0);
  });
});
