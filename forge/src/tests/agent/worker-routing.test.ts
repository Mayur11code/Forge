// src/tests/agent/worker-routing.test.ts
//
// Routing contract for the main QStash worker.
//
// Regression target: the dispatcher answered unknown and unhandled event
// types with HTTP 200, so an event could be published, the route could return
// success, and nothing would actually process it. In particular
// AGENT_TOOL_EXECUTION_REQUESTED had a dedicated route but no case in this
// dispatcher, so with USE_MULTI_TOPICS=false its delivery depended entirely on
// unverifiable external consumer configuration.
//
// The route builds its worker table at module load. The bindings are recorded
// on globalThis rather than a module-level Map because next/jest can resolve
// the "@/..." alias to a different module instance for the test file and the
// route, which would leave the test looking at an empty mock.

jest.mock("server-only", () => ({}));

jest.mock("@/app/api/worker/file-worker/fw", () => ({
  fileWorkerHandler: jest.fn(),
}));
jest.mock("@/app/api/worker/email-worker/ew", () => ({
  emailWorkerHandler: jest.fn(),
}));
jest.mock("@/app/api/worker/cron-worker/cw", () => ({
  cronWorkerHandler: jest.fn(),
}));
jest.mock("@/app/api/worker/embedding-worker/ew", () => ({
  embeddingWorkerHandler: jest.fn(),
}));
jest.mock("@/app/api/worker/agent-loop/al", () => ({
  handleAgentLoop: jest.fn(),
}));
jest.mock("@/lib/ai/agent/tool-worker", () => ({
  handleToolExecution: jest.fn(),
}));
jest.mock("@/app/api/worker/agent-maintenance/am", () => ({
  handleAgentMaintenance: jest.fn(),
}));

// `var` is deliberate: jest hoists the jest.mock call above module
// declarations, and a const would be in the temporal dead zone when the
// factory runs. The factory executes in this file's scope, so this binding is
// shared regardless of how many module instances load it.
// eslint-disable-next-line no-var
var workerBindings: Map<string, unknown>;

jest.mock("@/lib/events/worker", () => ({
  createWorker: (eventType: string, handler: unknown) => {
    if (!workerBindings) {
      workerBindings = new Map<string, unknown>();
    }

    workerBindings.set(eventType, handler);

    return async function invoke() {
      void handler;
      return new Response(JSON.stringify({ ok: true, eventType }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  },
}));

import { NextRequest } from "next/server";

import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { handleAgentLoop } from "@/app/api/worker/agent-loop/al";
import { handleAgentMaintenance } from "@/app/api/worker/agent-maintenance/am";
import { POST } from "@/app/api/worker/route";

const toolHandlerMock = handleToolExecution as jest.MockedFunction<
  typeof handleToolExecution
>;
const loopHandlerMock = handleAgentLoop as jest.MockedFunction<
  typeof handleAgentLoop
>;
const maintenanceHandlerMock = handleAgentMaintenance as jest.MockedFunction<
  typeof handleAgentMaintenance
>;

function bindings(): Map<string, unknown> {
  if (!workerBindings) {
    throw new Error("createWorker was never called");
  }

  return workerBindings;
}

function post(type?: string) {
  return POST(
    new NextRequest("http://localhost/api/worker", {
      method: "POST",
      body: JSON.stringify(type ? { type } : {}),
    }),
  );
}

describe("event to handler bindings", () => {
  it("binds AGENT_TOOL_EXECUTION_REQUESTED to the tool worker", () => {
    expect(bindings().get("AGENT_TOOL_EXECUTION_REQUESTED")).toBe(
      toolHandlerMock,
    );
  });

  it("binds AGENT_LOOP_REQUESTED to the agent loop worker", () => {
    expect(bindings().get("AGENT_LOOP_REQUESTED")).toBe(loopHandlerMock);
  });

  it("binds AGENT_MAINTENANCE_REQUESTED to the maintenance worker", () => {
    // The QStash schedule posts to this same endpoint. A missing binding would
    // make the scheduled sweep hit the "known event with no handler" branch and
    // fail on every single tick.
    expect(bindings().get("AGENT_MAINTENANCE_REQUESTED")).toBe(
      maintenanceHandlerMock,
    );
  });

  it("keeps the pre-existing non-agent bindings", () => {
    for (const type of [
      "FILE_UPLOADED",
      "SEND_EMAIL",
      "EMBEDDING_REQUESTED",
      "CRON_DAILY_DIGEST",
    ]) {
      expect(bindings().has(type)).toBe(true);
    }
  });
});

describe("dispatch", () => {
  it("routes AGENT_TOOL_EXECUTION_REQUESTED", async () => {
    const res = await post("AGENT_TOOL_EXECUTION_REQUESTED");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
    });
  });

  it("keeps AGENT_LOOP_REQUESTED working", async () => {
    const res = await post("AGENT_LOOP_REQUESTED");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      eventType: "AGENT_LOOP_REQUESTED",
    });
  });

  it("routes AGENT_MAINTENANCE_REQUESTED", async () => {
    const res = await post("AGENT_MAINTENANCE_REQUESTED");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      eventType: "AGENT_MAINTENANCE_REQUESTED",
    });
  });

  it("still dispatches the pre-existing non-agent events", async () => {
    for (const type of [
      "FILE_UPLOADED",
      "SEND_EMAIL",
      "EMBEDDING_REQUESTED",
      "CRON_DAILY_DIGEST",
    ]) {
      const res = await post(type);
      expect(res.status).toBe(200);
    }
  });
});

describe("unhandled and unknown events", () => {
  it("does not report success for a known event with no handler", async () => {
    // EXECUTE_WORKFLOW_NODE is a real EventType but has no case in this
    // dispatcher, so acknowledging it would be a silent drop. 5xx so QStash
    // retries rather than treating the message as delivered.
    const res = await post("EXECUTE_WORKFLOW_NODE");

    expect(res.status).toBe(500);
  });

  it("does not report success for an unknown event type", async () => {
    const res = await post("TOTALLY_UNKNOWN_EVENT");

    expect(res.status).toBe(400);
  });

  it("rejects a body with no event type", async () => {
    const res = await post(undefined);

    expect(res.status).toBe(400);
  });
});
