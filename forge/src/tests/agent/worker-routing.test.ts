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

jest.mock("@/app/api/worker/workflow-maintenance/wm", () => ({
  handleWorkflowMaintenance: jest.fn(),
}));

// The workflow engine's shared handler. Mocked so the dispatcher test does not
// need a database: what is under test here is WHICH handler a delivery is
// routed to, and that the signature check is applied to it.
jest.mock("@/app/api/workflow/wf", () => ({
  handleWorkflowEvent: jest.fn(),
}));

// The signature check, mocked with a switchable mode.
//
// `passthrough` records that verification was requested and then calls the
// handler, so the routing assertions can see the dispatch. `enforce` mirrors
// the real implementation's behaviour for a delivery with no
// `Upstash-Signature` header (403, not 500), which is the security property
// the workflow branch has to keep.
let signatureMode: "passthrough" | "enforce" = "passthrough";
const signatureChecks: string[] = [];

jest.mock("@upstash/qstash/nextjs", () => ({
  verifySignatureAppRouter: (handler: unknown) => async (req: Request) => {
    signatureChecks.push("verified");

    if (signatureMode === "enforce") {
      const signature = req.headers.get("upstash-signature");
      if (!signature) {
        return new Response("`Upstash-Signature` header is missing", {
          status: 403,
        });
      }
    }

    return (handler as (r: Request) => Response)(req);
  },
}));

// `var` is deliberate: jest hoists the jest.mock call above module
// declarations, and a const would be in the temporal dead zone when the
// factory runs. The factory executes in this file's scope, so this binding is
// shared regardless of how many module instances load it.
// eslint-disable-next-line no-var
var workerBindings: Map<string, unknown>;

// Lets a test make the wrapped handler throw, which is how the route's catch
// block is reached. verifySignatureAppRouter is mocked out here, so without this
// the signature-rejection path cannot be exercised at all.
// eslint-disable-next-line no-var
var dispatchOverride: (() => void) | null = null;

jest.mock("@/lib/events/worker", () => ({
  createWorker: (eventType: string, handler: unknown) => {
    if (!workerBindings) {
      workerBindings = new Map<string, unknown>();
    }

    workerBindings.set(eventType, handler);

    return async function invoke() {
      if (dispatchOverride) {
        dispatchOverride();
      }

      void handler;
      return new Response(JSON.stringify({ ok: true, eventType }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  },
}));

import { NextRequest, NextResponse } from "next/server";

import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { handleAgentLoop } from "@/app/api/worker/agent-loop/al";
import { handleWorkflowMaintenance } from "@/app/api/worker/workflow-maintenance/wm";
import { handleAgentMaintenance } from "@/app/api/worker/agent-maintenance/am";
import { handleWorkflowEvent } from "@/app/api/workflow/wf";
import { POST } from "@/app/api/worker/route";

const toolHandlerMock = handleToolExecution as jest.MockedFunction<
  typeof handleToolExecution
>;
const loopHandlerMock = handleAgentLoop as jest.MockedFunction<
  typeof handleAgentLoop
>;
const workflowMaintenanceHandlerMock =
  handleWorkflowMaintenance as jest.MockedFunction<
    typeof handleWorkflowMaintenance
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

  it("binds WORKFLOW_MAINTENANCE_REQUESTED to the workflow maintenance worker", () => {
    // Same reasoning as the agent sweep: a missing binding turns every
    // scheduled tick into the "known event with no handler" 500.
    expect(bindings().get("WORKFLOW_MAINTENANCE_REQUESTED")).toBe(
      workflowMaintenanceHandlerMock,
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

  it("routes WORKFLOW_MAINTENANCE_REQUESTED", async () => {
    const res = await post("WORKFLOW_MAINTENANCE_REQUESTED");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      eventType: "WORKFLOW_MAINTENANCE_REQUESTED",
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
    // TASK_CREATED is a real EventType that no branch of this dispatcher
    // handles, so acknowledging it would be a silent drop. 5xx so QStash
    // retries rather than treating the message as delivered.
    const res = await post("TASK_CREATED");

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

describe("signature failures", () => {
  // Regression target: verifySignatureAppRouter throws SignatureError, and the
  // outer catch turned every one of them into 500 "Router failed". QStash retries
  // 5xx, so a forged or misconfigured delivery was retried against its whole
  // budget for a request that can never succeed, and an authentication decision
  // was reported as an infrastructure fault.
  function throwSignatureError() {
    const err = new Error("Invalid Compact JWS");
    err.name = "SignatureError";
    throw err;
  }

  afterEach(() => {
    dispatchOverride = null;
  });

  it.each([
    ["AGENT_LOOP_REQUESTED"],
    ["AGENT_TOOL_EXECUTION_REQUESTED"],
    ["AGENT_MAINTENANCE_REQUESTED"],
  ])("answers 401, not a retryable 500, for %s", async (type) => {
    dispatchOverride = throwSignatureError;

    const res = await post(type);

    // Non-retryable on purpose: retrying cannot fix a bad signature.
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("does not leak why verification failed", async () => {
    dispatchOverride = throwSignatureError;

    const res = await post("AGENT_LOOP_REQUESTED");
    const body = JSON.stringify(await res.json());

    // The precise cause is what an attacker probing this endpoint wants back.
    expect(body).not.toMatch(/jws|jwt|signature|compact/i);
  });

  it("still returns 500 for a genuine infrastructure failure", async () => {
    // The retry budget exists for this, so the 401 path must not swallow it.
    dispatchOverride = () => {
      throw new Error("ECONNRESET talking to Postgres");
    };

    const res = await post("AGENT_LOOP_REQUESTED");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The workflow engine's two events
// ---------------------------------------------------------------------------

// Regression target for a live, blocking defect found by the 37.16 capstone.
//
// The engine publishes EXECUTE_WORKFLOW_NODE and ADVANCE_WORKFLOW to the
// single "events" QStash topic, whose one endpoint is this route. Their
// handlers used to live only at /api/workflow, which nothing publishes to, so
// every delivery landed here, fell through to the "known event with no handler"
// branch, and was answered with a 500 that QStash retried three times before
// abandoning it. The run then sat at RUNNING with its step PENDING for ever -
// no workflow could execute a single step, however it was started.
//
// A live run of that shape was observed: run cmvjinlpu0010vcgcp1sgsphg, step
// kickoff_task, status PENDING, with "[WORKER] No handler configured for known
// event: EXECUTE_WORKFLOW_NODE" in the worker log for every delivery.
describe("workflow engine events", () => {
  const workflowHandlerMock =
    handleWorkflowEvent as jest.MockedFunction<typeof handleWorkflowEvent>;

  beforeEach(() => {
    signatureMode = "passthrough";
    signatureChecks.length = 0;
    workflowHandlerMock.mockReset();
    workflowHandlerMock.mockImplementation(
      async () => new NextResponse("Execution Complete", { status: 200 }),
    );
  });

  it.each([["EXECUTE_WORKFLOW_NODE"], ["ADVANCE_WORKFLOW"]])(
    "routes %s to the workflow engine handler",
    async (type) => {
      const res = await post(type);

      expect(res.status).toBe(200);
      expect(workflowHandlerMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not answer 500 for an event the engine owns", async () => {
    // The failure mode this replaces: a 500 from the "no handler" branch, which
    // QStash retried and then abandoned.
    for (const type of ["EXECUTE_WORKFLOW_NODE", "ADVANCE_WORKFLOW"]) {
      const res = await post(type);
      expect(res.status).not.toBe(500);
    }
  });

  it("refuses an unsigned engine event without running it", async () => {
    // These two events run real actions and mutate real workflow state, and
    // this dispatcher does not verify at the top level - each branch verifies
    // its own delivery. An unsigned delivery must be refused, not executed.
    //
    // The 403 body comes from the verifier itself and names the missing
    // header. That discloses nothing the caller does not already know - it is
    // not the "why verification failed" detail the terse 401 path in this
    // dispatcher exists to withhold. What matters is the status and the fact
    // that the handler never ran.
    signatureMode = "enforce";

    const res = await post("EXECUTE_WORKFLOW_NODE");

    expect(res.status).toBe(403);
    expect(workflowHandlerMock).not.toHaveBeenCalled();
  });

  it("does not disclose key material in the refusal", async () => {
    signatureMode = "enforce";

    const res = await post("ADVANCE_WORKFLOW");
    const body = String(await res.text());

    expect(body).not.toMatch(/key|secret|signing key|-----BEGIN/i);
  });
});
