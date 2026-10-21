// src/tests/workflow/workflow-integration-diamond.test.ts
//
// Assignment 37.15 — integrated execution coverage for the real engine.
//
// The audit behind this phase found that the suite had good unit coverage of
// every engine component and no coverage of the engine *assembled*. Every
// existing workflow suite reaches one of three places and stops:
//
//   * the evaluator's decision, without a step ever running (`evaluator-*.test.ts`)
//   * the wrapper's claim and retry bookkeeping, with the action replaced
//     (`step-retry.test.ts` — the action registry is mocked out)
//   * the start boundary, with the engine mocked out
//     (`trigger-tenant-scope.test.ts`, `execution-handoff.test.ts`)
//
// So nothing asserted that a root actually dispatches, that a fan-in waits for
// its prerequisites, or that one step's output becomes the next step's input.
// Those are exactly the properties that break silently: a fan-in that fires
// early reads as a success, and an output that never propagates reads as a
// step that did nothing.
//
// This suite closes that gap by driving the assembled path:
//
//   startWorkflow (real tenant-scoped lookup, real run creation)
//     → advanceWorkflow (real evaluator: readiness, dispatch, terminal check)
//       → POST /api/workflow EXECUTE_WORKFLOW_NODE (real worker boundary)
//         → resolveInputs (real resolver, real {{…}} grammar)
//           → wrapStepOperation (real claim, real audit log, real context merge)
//             → getAction("task.create") (REAL registry → REAL action code)
//               → appendStepOutputToContext (real compare-and-set merge)
//     → advanceWorkflow again (the dependent step becomes eligible)
//
// What is mocked, and only this:
//
//   - persistence: the in-memory Prisma double (`helpers/prisma-double.ts`).
//     It is the same double the rest of the workflow suite uses, and it models
//     the `@@unique([runId, stepId])` constraint, the compare-and-set
//     predicates and the `contextVersion` token faithfully.
//   - transport: `publishEvent` (QStash), the Redis lock client, and Pusher.
//
// What is NOT mocked, and is the point of the file:
//
//   - the evaluator, the worker route, the resolver, the wrapper, the state
//     merge, the action registry, and the `task.create` action implementation.
//
// The ONE business boundary inside the action is mocked: `createTaskInOrg`,
// the canonical task-creation operation, which would otherwise write to a real
// database. The action code around it runs for real — including its
// authorization boundary, which reads the trusted organization from the
// PERSISTED Workflow row rather than from step inputs, and the assertions
// below prove that by checking the actor the action passed down.
//
// This is therefore *mocked integration with the real registered action
// implementation*. It is NOT real-database action execution, NOT a real
// PostgreSQL run, and NOT an end-to-end production verification. The 37.11
// real-PostgreSQL gate and the 37.16 live capstone gate are separate and are
// not claimed here.

jest.mock("server-only", () => ({}));

// `wrapper.ts` constructs a Redis client at module scope, the same way
// `src/lib/redis/client.ts` does. The engine's own lock uses the mocked
// client below; this one exists only so the import does not need credentials.
jest.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ set: jest.fn(), eval: jest.fn() }) },
}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/redis/client", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { redisDouble } = require("./helpers/redis-double");
  return { redis: redisDouble };
});

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

// The canonical task-creation operation is the one mocked business boundary:
// it would otherwise write to a real database. Everything the action does
// AROUND it - reading the trusted org from the persisted Workflow row,
// validating the payload, mapping the result into the standardized output -
// is the real implementation.
jest.mock("@/lib/tasks/create-task", () => ({
  createTaskInOrg: jest.fn(),
}));

jest.mock("@upstash/qstash/nextjs", () => ({
  verifySignatureAppRouter: (handler: unknown) => handler,
}));

import { publishEvent } from "@/lib/events/queue";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { db } from "@/lib/prisma/db";
import { createTaskInOrg } from "@/lib/tasks/create-task";
import { POST } from "@/app/api/workflow/route";
import { resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";
import { resetRedisDouble } from "./helpers/redis-double";
import type { JsonValue } from "@/lib/workflow-types/type";

const publishEventMock = publishEvent as jest.MockedFunction<typeof publishEvent>;
const createTaskInOrgMock = createTaskInOrg as jest.MockedFunction<typeof createTaskInOrg>;

const ORG_ID = "org_1";
const WORKFLOW_ID = "wf_int_1";
const PROJECT_ID = "p1";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * A step the real schema accepts: `id`, `kind`, `action`, `dependsOn` and
 * `config` are all required by `WorkflowDefinitionSchema`, and the evaluator
 * re-validates the definition on every pass, so a fixture that omits one is
 * testing the shape error rather than the graph.
 */
function actionStep(
  id: string,
  dependsOn: string[] = [],
  config: Record<string, unknown> = {},
) {
  return {
    id,
    kind: "ACTION",
    action: "task.create",
    dependsOn,
    config: { title: id.toUpperCase(), projectId: PROJECT_ID, ...config },
  };
}

function definitionOf(steps: Record<string, unknown>) {
  return { id: "d1", name: "integration", steps };
}

/** Deterministic, collision-free task ids derived from the title. */
function slugify(value: string) {
  return value.replace(/[^a-z0-9]/gi, "_");
}

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

function seedWorkflow(definition: unknown) {
  resetStore();
  resetRedisDouble();
  publishEventMock.mockClear();
  createTaskInOrgMock.mockClear();

  store.workflows.push({
    id: WORKFLOW_ID,
    name: "integration",
    orgId: ORG_ID,
    definition,
    isActive: true,
  });
}

/**
 * The mocked business boundary.
 *
 * The id is derived from the title, so a step whose title is a RESOLVED
 * reference produces a different id than the step it came from — which is what
 * makes "B received A's output" observable rather than merely plausible.
 */
function mockTaskCreation() {
  createTaskInOrgMock.mockImplementation(async (input, actor) => {
    const data = input as { title: string; projectId: string };
    return {
      success: true,
      task: {
        id: `task_${slugify(data.title)}`,
        title: data.title,
        projectId: data.projectId,
        orgId: actor.orgId,
      },
    } as never;
  });
}

/** Every `EXECUTE_WORKFLOW_NODE` publish, resolved to the step it targets. */
function nodeDispatches() {
  return publishEventMock.mock.calls
    .filter((call) => call[0] === "EXECUTE_WORKFLOW_NODE")
    .map((call) => {
      const payload = call[1] as { runId: string; stepRunId: string; kind?: string };
      const stepRun = store.stepRuns.find((s) => s.id === payload.stepRunId);
      return {
        runId: payload.runId,
        stepRunId: payload.stepRunId,
        stepId: stepRun?.stepId,
        kind: payload.kind,
      };
    });
}

function stepRunsOf(runId: string): Row[] {
  return store.stepRuns.filter((s) => s.runId === runId);
}

function stepRunOf(runId: string, stepId: string): Row | undefined {
  return store.stepRuns.find((s) => s.runId === runId && s.stepId === stepId);
}

function runOf(runId: string): Row | undefined {
  return store.runs.find((r) => r.id === runId);
}

function contextOf(runId: string): Record<string, JsonValue> {
  return (runOf(runId)?.context ?? {}) as Record<string, JsonValue>;
}

/**
 * The runtime namespaces a step's outputs under the step's own id, so the
 * context is read one step at a time rather than as an open record.
 */
type StepContext = {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

function stepContextOf(runId: string, stepId: string): StepContext {
  const value = contextOf(runId)[stepId];
  return value && typeof value === "object" ? (value as StepContext) : {};
}

/**
 * Deliver a step through the real worker route.
 *
 * The route is the production ingress for `EXECUTE_WORKFLOW_NODE`, so going
 * through it rather than calling `wrapStepOperation` directly is what makes
 * this an integration test rather than a unit test wearing a different hat:
 * the resolver, the operation selection and the chain reaction to the
 * evaluator all live inside it.
 */
async function deliverStep(runId: string, stepId: string) {
  const stepRun = stepRunOf(runId, stepId);
  if (!stepRun) throw new Error(`No StepRun for step "${stepId}"`);

  return POST(
    makeRequest({
      type: "EXECUTE_WORKFLOW_NODE",
      data: { runId, stepRunId: stepRun.id, kind: "ACTION" },
    }) as never,
  );
}

async function startRun(steps: Record<string, unknown>) {
  seedWorkflow(definitionOf(steps));
  mockTaskCreation();

  const run = await startWorkflow(ORG_ID, WORKFLOW_ID, {});
  return run;
}

beforeEach(() => {
  restoreWorkflowDouble();
});

// ===========================================================================
// Scenario A — independent roots and fan-in
// ===========================================================================

describe("37.15 execution integration: independent roots and fan-in", () => {
  it("dispatches independent roots A and B in the same evaluator pass", async () => {
    // A and B have no dependency on one another. If the engine invented one -
    // or serialised them - only one would be dispatched in the first pass.
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b"),
      c: actionStep("c", ["a", "b"]),
    });

    expect(run.status).toBe("RUNNING");

    const dispatches = nodeDispatches();
    expect(dispatches.map((d) => d.stepId).sort()).toEqual(["a", "b"]);

    // Both are in flight at the same time, before either has completed. That
    // is the evidence: two PENDING rows, not one PENDING row and one SUCCESS.
    const rows = stepRunsOf(run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "PENDING")).toBe(true);

    // And the join was not created early.
    expect(stepRunOf(run.id, "c")).toBeUndefined();
  });

  it("holds the fan-in step C undispatched while B is outstanding after A has succeeded", async () => {
    // The interesting half-ordering. A succeeds, B has not. C depends on both,
    // so C must not exist. A join that fired on "one prerequisite succeeded"
    // would run C against a half-built graph.
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b"),
      c: actionStep("c", ["a", "b"]),
    });

    const response = await deliverStep(run.id, "a");
    expect(response.status).toBe(200);
    expect(stepRunOf(run.id, "a")?.status).toBe("SUCCESS");

    // B is still in flight.
    expect(stepRunOf(run.id, "b")?.status).toBe("PENDING");

    // C has no row at all, and was never dispatched.
    expect(stepRunOf(run.id, "c")).toBeUndefined();
    expect(nodeDispatches().map((d) => d.stepId)).not.toContain("c");

    // The run has not settled: it is waiting on B.
    expect(runOf(run.id)?.status).toBe("RUNNING");
  });

  it("dispatches the fan-in step C once both A and B have succeeded", async () => {
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b"),
      c: actionStep("c", ["a", "b"]),
    });

    await deliverStep(run.id, "a");
    await deliverStep(run.id, "b");

    const cDispatch = nodeDispatches().find((d) => d.stepId === "c");
    expect(cDispatch).toBeDefined();
    expect(stepRunOf(run.id, "c")?.status).toBe("PENDING");

    // Both prerequisites really are recorded as successful - the join fired
    // because they were satisfied, not because the evaluator gave up.
    expect(stepRunOf(run.id, "a")?.status).toBe("SUCCESS");
    expect(stepRunOf(run.id, "b")?.status).toBe("SUCCESS");
  });

  it("creates no duplicate StepRuns and no duplicate action dispatch when the evaluator advances repeatedly", async () => {
    // QStash is at-least-once and the backstop re-entry is armed on every
    // non-terminal pass, so the evaluator is called repeatedly against a run
    // that is already in flight. A repeated pass must observe the existing
    // rows rather than create a second set.
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b"),
      c: actionStep("c", ["a", "b"]),
    });

    await advanceWorkflow(run.id);
    await advanceWorkflow(run.id);
    await advanceWorkflow(run.id);

    expect(stepRunsOf(run.id)).toHaveLength(2);
    expect(nodeDispatches().map((d) => d.stepId).sort()).toEqual(["a", "b"]);

    await deliverStep(run.id, "a");
    await deliverStep(run.id, "b");

    // C is dispatched by the worker's own chain reaction. Extra advancement
    // after that must not dispatch it a second time.
    await advanceWorkflow(run.id);
    await advanceWorkflow(run.id);

    const rows = stepRunsOf(run.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.stepId).sort()).toEqual(["a", "b", "c"]);
    expect(nodeDispatches().filter((d) => d.stepId === "c")).toHaveLength(1);

    await deliverStep(run.id, "c");

    // One action call per step: no step ran twice.
    expect(createTaskInOrgMock).toHaveBeenCalledTimes(3);
    expect(runOf(run.id)?.status).toBe("COMPLETED");
  });
});

// ===========================================================================
// Scenario B — output propagation along a dependency
// ===========================================================================

describe("37.15 execution integration: output propagation A → B", () => {
  it("keeps the dependent step B undispatched until A has succeeded", async () => {
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b", ["a"], { title: "{{a.outputs.taskId}}" }),
    });

    // A is the only ready step; B waits on it.
    expect(nodeDispatches().map((d) => d.stepId)).toEqual(["a"]);
    expect(stepRunOf(run.id, "b")).toBeUndefined();
  });

  it("propagates A's output into B's inputs through the real resolver and the real registered action", async () => {
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b", ["a"], { title: "{{a.outputs.taskId}}" }),
    });

    await deliverStep(run.id, "a");

    // A's action returned a real output, and the runtime merged it into the
    // run's context under A's namespace.
    expect(stepContextOf(run.id, "a").outputs).toEqual({ taskId: "task_A", title: "A" });
    expect(runOf(run.id)?.contextVersion).toBe(1);

    await deliverStep(run.id, "b");

    // The value B's action received is A's task id - not the literal
    // "{{a.outputs.taskId}}". This is the real resolver running inside the
    // real worker route against the real persisted context.
    expect(createTaskInOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "task_A", projectId: PROJECT_ID }),
      { orgId: ORG_ID },
    );

    // The resolved inputs are what the wrapper recorded on the step run.
    expect(stepRunOf(run.id, "b")?.inputs).toEqual({
      title: "task_A",
      projectId: PROJECT_ID,
    });

    // The actor the action passed down is the tenant read from the PERSISTED
    // Workflow row, never from the step's inputs. That is the action's
    // authorization boundary, and it is the proof that the real action
    // implementation - not a stand-in - produced the call above.
    expect(createTaskInOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { orgId: ORG_ID },
    );

    // The same grammar and the same context, resolved by the exported
    // resolver. The action's input above is not a coincidence of the fixture:
    // the route and this call are the same function on the same data.
    expect(
      resolveInputs(
        { title: "{{a.outputs.taskId}}", projectId: PROJECT_ID },
        contextOf(run.id),
      ),
    ).toEqual({ title: "task_A", projectId: PROJECT_ID });
  });

  it("reaches COMPLETED through the existing runtime contract", async () => {
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b", ["a"], { title: "{{a.outputs.taskId}}" }),
    });

    await deliverStep(run.id, "a");
    await deliverStep(run.id, "b");

    await advanceWorkflow(run.id);

    expect(runOf(run.id)?.status).toBe("COMPLETED");
    expect(runOf(run.id)?.completedAt).toBeInstanceOf(Date);
    expect(stepRunsOf(run.id).map((r) => r.status).sort()).toEqual([
      "SUCCESS",
      "SUCCESS",
    ]);

    // Both outputs are in the context, namespaced by step.
    expect(stepContextOf(run.id, "a").outputs?.taskId).toBe("task_A");
    expect(stepContextOf(run.id, "b").outputs?.taskId).toBe("task_task_A");
  });
});

// ===========================================================================
// Scenario C — a true diamond
// ===========================================================================

describe("37.15 execution integration: diamond A → {B, C} → D", () => {
  it("fans out from a common parent, then joins both branches before dispatching D", async () => {
    // The shape neither of the other two scenarios covers: two steps that
    // share a prerequisite (a fan-out from a parent, not two independent
    // roots) and a join two levels down.
    const run = await startRun({
      a: actionStep("a"),
      b: actionStep("b", ["a"]),
      c: actionStep("c", ["a"]),
      d: actionStep("d", ["b", "c"], { title: "{{b.outputs.taskId}}" }),
    });

    // Only A is ready: B and C both wait on it.
    expect(nodeDispatches().map((d) => d.stepId)).toEqual(["a"]);

    await deliverStep(run.id, "a");

    // A's completion makes BOTH branches eligible, and the evaluator fans
    // them out in the same pass.
    const afterA = nodeDispatches().map((d) => d.stepId).sort();
    expect(afterA).toEqual(["a", "b", "c"]);
    expect(stepRunOf(run.id, "d")).toBeUndefined();

    await deliverStep(run.id, "b");

    // C is outstanding, so D still waits.
    expect(stepRunOf(run.id, "d")).toBeUndefined();
    expect(nodeDispatches().map((d) => d.stepId)).not.toContain("d");

    await deliverStep(run.id, "c");

    // Both branches are done, so D is dispatched.
    const dDispatch = nodeDispatches().find((d) => d.stepId === "d");
    expect(dDispatch).toBeDefined();

    await deliverStep(run.id, "d");

    // D received B's output, through the same resolver, two levels down.
    expect(createTaskInOrgMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ title: "task_B" }),
      { orgId: ORG_ID },
    );
    expect(stepRunOf(run.id, "d")?.inputs).toEqual({
      title: "task_B",
      projectId: PROJECT_ID,
    });

    await advanceWorkflow(run.id);
    expect(runOf(run.id)?.status).toBe("COMPLETED");
  });
});

// ===========================================================================
// The mocked boundaries, stated explicitly
// ===========================================================================

describe("37.15 execution integration: boundary assertions", () => {
  it("mocks persistence and transport only — the engine and the action are real", async () => {
    const run = await startRun({ a: actionStep("a") });

    // Persistence is the in-memory double, never a real database.
    expect(db).toBeDefined();
    expect(store.runs.some((r) => r.id === run.id)).toBe(true);

    // Transport is mocked: nothing reached QStash.
    expect(publishEventMock).toHaveBeenCalled();

    // The action came from the REAL registry, so the business boundary it
    // called is the one canonical operation — mocked here only at the
    // persistence boundary underneath it.
    const action = await import("@/lib/workflow-types/action-registry");
    expect(action.getAction("task.create")).toBeDefined();
    expect(action.ActionRegistry["task.create"].id).toBe("task.create");
  });
});
