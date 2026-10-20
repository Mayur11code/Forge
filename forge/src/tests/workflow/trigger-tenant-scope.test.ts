// src/tests/workflow/trigger-tenant-scope.test.ts
//
// I6 — tenant scope of `startWorkflow`, the ignition point of the execution
// engine.
//
// The lookup used to be `db.workflow.findUnique({ where: { id: workflowId } })`.
// An existence check is not an authorization check: any caller that could reach
// this function could name any workflow id and start a run against another
// tenant's graph. The boundary fix is twofold — the id is now looked up under a
// caller-supplied, *verified* `orgId`, and the parameter is required so no
// unscoped call shape exists.
//
// The properties asserted here are the ones a later refactor has to preserve:
//
//   1. A foreign workflow is refused AND nothing is created or dispatched.
//      Asserting only the throw would still pass if the code checked the tenant
//      and then created the run anyway.
//   2. The lookup predicate carries `orgId`, not only `id`. This is the actual
//      fix: the tenant constraint has to ride in the same query that gates run
//      creation, or the read could authorize a row the write then ignores.
//   3. "Not yours" and "does not exist" are the same error, so the trigger is
//      not an existence oracle.
//   4. The same-org positive path still creates the run and pushes the first
//      domino — the fix must not break legitimate execution.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: { findFirst: jest.fn() },
    workflowRun: { create: jest.fn() },
  },
}));

// The engine is not the subject here; `startWorkflow` is the boundary that hands
// work to it. Mocking `advanceWorkflow` keeps the assertion on "was the first
// domino pushed" without dragging the evaluator's own stores into the test.
jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn(),
}));

import { db } from "@/lib/prisma/db";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { startWorkflow } from "@/lib/workflow/execution/trigger";

const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const workflowRunCreate = db.workflowRun.create as jest.Mock;
const advanceWorkflowMock = advanceWorkflow as jest.Mock;

const ORG_A = "org_a";
const ORG_B = "org_b";
const WORKFLOW_ID = "wf_1";

const NOT_FOUND = `Cannot start workflow: ${WORKFLOW_ID} not found.`;

beforeEach(() => {
  jest.clearAllMocks();
  workflowRunCreate.mockResolvedValue({ id: "run_1" });
  advanceWorkflowMock.mockResolvedValue(undefined);
});

describe("startWorkflow tenant scope", () => {
  it("looks the workflow up under the caller's orgId, not id alone", async () => {
    workflowFindFirst.mockResolvedValue({ id: WORKFLOW_ID, orgId: ORG_A, name: "W" });

    await startWorkflow(ORG_A, WORKFLOW_ID);

    expect(workflowFindFirst).toHaveBeenCalledWith({
      where: { id: WORKFLOW_ID, orgId: ORG_A },
    });
  });

  it("refuses another organization's workflow and creates no run", async () => {
    // The tenant predicate is what a real database would apply: a workflow owned
    // by ORG_B does not match a lookup scoped to ORG_A.
    workflowFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.orgId === ORG_B ? { id: WORKFLOW_ID, orgId: ORG_B, name: "W" } : null,
    );

    await expect(startWorkflow(ORG_A, WORKFLOW_ID)).rejects.toThrow(NOT_FOUND);

    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("refuses a workflow that does not exist, indistinguishably", async () => {
    workflowFindFirst.mockResolvedValue(null);

    await expect(startWorkflow(ORG_A, WORKFLOW_ID)).rejects.toThrow(NOT_FOUND);
    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("starts the run and pushes the first domino for the owning organization", async () => {
    workflowFindFirst.mockResolvedValue({ id: WORKFLOW_ID, orgId: ORG_A, name: "W" });

    const run = await startWorkflow(ORG_A, WORKFLOW_ID, { projectId: "p_1" });

    expect(run).toEqual({ id: "run_1" });
    expect(workflowRunCreate).toHaveBeenCalledWith({
      data: {
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        context: { trigger: { outputs: { projectId: "p_1" } } },
      },
    });
    expect(advanceWorkflowMock).toHaveBeenCalledWith("run_1");
  });
});
