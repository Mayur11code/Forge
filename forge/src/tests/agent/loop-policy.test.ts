// src/tests/agent/loop-policy.test.ts
//
// Contracts for the two rules that govern the agent loop:
//   1. MAX_AGENT_STEPS is the number of allowed Gemini calls
//   2. exactly one tool call per model turn
//
// These are pure decisions, so they are tested directly without mocking the
// model, Prisma or Redis.

import {
  decideStepGate,
  decideToolCalls,
} from "@/lib/ai/agent/loop-policy";
import { MAX_AGENT_STEPS } from "@/lib/ai/agent/constants";

type Call = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

/**
 * Replays the durable claim + step gate exactly as the runtime does:
 * a delivery is ignored unless its expectedStep matches the current step
 * (the CAS in claimNextAgentStep), the claim increments, then the gate runs.
 */
function simulateLoop({
  deliveries,
  maxSteps = MAX_AGENT_STEPS,
}: {
  deliveries: number[];
  maxSteps?: number;
}) {
  let currentStep = 0;
  let modelCalls = 0;
  const terminal: string[] = [];

  for (const expectedStep of deliveries) {
    if (currentStep !== expectedStep) {
      // CAS fails: stale or duplicate delivery. No claim, no model call.
      continue;
    }

    currentStep += 1;

    const gate = decideStepGate(currentStep, maxSteps);

    if (gate.kind === "STOP_MAX_STEPS") {
      terminal.push("MAX_STEPS_EXCEEDED");
      break;
    }

    modelCalls += 1;
  }

  return { modelCalls, terminal, finalStep: currentStep };
}

describe("MAX_AGENT_STEPS boundary", () => {
  it("permits a model turn at every step up to and including the limit", () => {
    for (let currentStep = 1; currentStep <= MAX_AGENT_STEPS; currentStep += 1) {
      expect(decideStepGate(currentStep).kind).toBe("RUN");
    }
  });

  it("blocks the first turn beyond the limit", () => {
    const decision = decideStepGate(MAX_AGENT_STEPS + 1);

    expect(decision.kind).toBe("STOP_MAX_STEPS");

    if (decision.kind === "STOP_MAX_STEPS") {
      expect(decision.currentStep).toBe(MAX_AGENT_STEPS + 1);
      expect(decision.maxSteps).toBe(MAX_AGENT_STEPS);
    }
  });

  it("regression: does not cap the loop at MAX_AGENT_STEPS - 1", () => {
    // The previous guard used >= against the post-claim step, which silently
    // allowed only 4 model calls when MAX_AGENT_STEPS was 5.
    expect(MAX_AGENT_STEPS).toBe(5);

    const { modelCalls, terminal } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 5],
    });

    expect(modelCalls).toBe(MAX_AGENT_STEPS);
    expect(terminal).toEqual(["MAX_STEPS_EXCEEDED"]);
  });

  it("never calls the model again after the terminal step", () => {
    const { modelCalls, terminal } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });

    expect(modelCalls).toBe(MAX_AGENT_STEPS);
    expect(terminal).toEqual(["MAX_STEPS_EXCEEDED"]);
  });

  it("reports the terminal state exactly once", () => {
    const { terminal } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 5, 6, 7],
    });

    expect(terminal).toHaveLength(1);
  });
});

describe("stale and duplicate deliveries", () => {
  it("cannot open extra model turns", () => {
    const { modelCalls, finalStep } = simulateLoop({
      deliveries: [0, 0, 0, 1, 1, 2, 2, 3],
    });

    // Only steps 0, 1, 2, 3 were accepted by the CAS.
    expect(finalStep).toBe(4);
    expect(modelCalls).toBe(4);
  });

  it("a replayed out-of-order event cannot bypass the max-step guard", () => {
    // Rewound events (expectedStep 0) arrive after the loop has advanced.
    // The CAS only advances from the exact expected value, so they are all
    // rejected: the step counter cannot be moved backwards and no extra
    // model turn is permitted.
    const { modelCalls, terminal, finalStep } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 0, 0, 0],
    });

    expect(modelCalls).toBe(MAX_AGENT_STEPS);
    expect(finalStep).toBe(MAX_AGENT_STEPS);
    // No spurious terminal: the rewinds were ignored rather than treated as
    // new work.
    expect(terminal).toEqual([]);
  });

  it("a rewind followed by a real next step still terminates correctly", () => {
    const { modelCalls, terminal } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 0, 5],
    });

    expect(modelCalls).toBe(MAX_AGENT_STEPS);
    expect(terminal).toEqual(["MAX_STEPS_EXCEEDED"]);
  });

  it("a duplicate at the boundary does not produce a second terminal", () => {
    const { terminal, modelCalls } = simulateLoop({
      deliveries: [0, 1, 2, 3, 4, 5, 5, 5, 5],
    });

    expect(modelCalls).toBe(MAX_AGENT_STEPS);
    expect(terminal).toEqual(["MAX_STEPS_EXCEEDED"]);
  });
});

describe("one tool call per model turn", () => {
  const call = (name: string, id: string): Call => ({
    toolName: name,
    toolCallId: id,
    input: { title: "t", projectName: "p" },
  });

  it("treats a text turn as no calls", () => {
    expect(decideToolCalls([]).kind).toBe("NO_CALLS");
  });

  it("accepts exactly one call and carries it through", () => {
    const decision = decideToolCalls([call("createTask", "call_1")]);

    expect(decision.kind).toBe("ONE_CALL");

    if (decision.kind === "ONE_CALL") {
      expect(decision.toolName).toBe("createTask");
      expect(decision.toolCallId).toBe("call_1");
      expect(decision.input).toEqual({ title: "t", projectName: "p" });
    }
  });

  it("rejects two calls and exposes no usable call", () => {
    const decision = decideToolCalls([
      call("createTask", "call_1"),
      call("createTask", "call_2"),
    ]);

    expect(decision.kind).toBe("TOO_MANY_CALLS");

    if (decision.kind === "TOO_MANY_CALLS") {
      expect(decision.count).toBe(2);
    }

    // Critically: no toolCallId is available, so the caller cannot persist an
    // assistant message whose tool calls would never receive a result.
    expect(decision).not.toHaveProperty("toolCallId");
    expect(decision).not.toHaveProperty("input");
  });

  it("rejects three calls", () => {
    const decision = decideToolCalls([
      call("createTask", "call_1"),
      call("createTask", "call_2"),
      call("createTask", "call_3"),
    ]);

    expect(decision.kind).toBe("TOO_MANY_CALLS");
  });

  it("guards against a missing call element", () => {
    const decision = decideToolCalls([undefined as unknown as Call]);

    expect(decision.kind).toBe("EMPTY_TOOL_CLAIMS");
  });
});
