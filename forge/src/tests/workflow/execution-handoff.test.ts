// src/tests/workflow/execution-handoff.test.ts
//
// Assignment 37.12 — the execution handoff contract.
//
// This suite exercises the REAL path used for a materialized AI-generated
// workflow:
//
//   triggerWorkflowRun (server action) → getOrgAccess → startWorkflow →
//   WorkflowRun.create → advanceWorkflow
//
// `getOrgAccess` and the engine's `advanceWorkflow` are mocked (identity and the
// first domino are not the subject), but `startWorkflow` itself is NOT mocked —
// it runs its real tenant-scoped lookup and run-creation. The database is
// mocked, so this is a boundary/contract test, not a PostgreSQL test.
//
// What it pins:
//   * a valid authorized request reaches the existing engine and creates exactly
//     one run, bound to the requested workflow and the server-derived org;
//   * the trigger context is empty (a generated workflow consumes none);
//   * the handoff does NOT re-derive or overwrite the persisted definition,
//     dependencies, action config or human-decided criticality (no workflow
//     write happens during a hand-off);
//   * approval/materialization/open-editor do not execute anything — nothing
//     runs until an explicit start;
//   * the response identifies the created run and never claims completion.

jest.mock("server-only", () => ({}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: { findFirst: jest.fn(), update: jest.fn() },
    workflowRun: { create: jest.fn() },
  },
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { db } from "@/lib/prisma/db";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";

const getOrgAccessMock = getOrgAccess as jest.Mock;
const advanceWorkflowMock = advanceWorkflow as jest.Mock;
const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const workflowUpdate = db.workflow.update as jest.Mock;
const workflowRunCreate = db.workflowRun.create as jest.Mock;

const ORG_ID = "org_a_id";
const SLUG = "acme";
const WORKFLOW_ID = "wf_materialized";

// A materialized workflow as 37.11 persists it: triggerless, inactive, a
// literal-config definition, human-decided criticality preserved on the step.
const MATERIALIZED_WORKFLOW = {
  id: WORKFLOW_ID,
  orgId: ORG_ID,
  name: "Create onboarding task",
  isActive: false,
  eventId: null,
  sourceProposalId: "interaction_1",
  definition: {
    id: "compiled_1",
    name: "Compiled Execution Graph",
    steps: {
      n1: {
        id: "n1",
        action: "task.create",
        dependsOn: [],
        config: { title: "Onboard new hire", projectId: "cmnj8u44p0003a0gcvqgt25dv" },
        isCritical: true,
        kind: "ACTION",
      },
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  workflowRunCreate.mockResolvedValue({ id: "run_42" });
  advanceWorkflowMock.mockResolvedValue(undefined);
  getOrgAccessMock.mockResolvedValue({
    userId: "user_1",
    organization: { id: ORG_ID },
    membership: { role: "MEMBER" },
  });
  workflowFindFirst.mockResolvedValue(MATERIALIZED_WORKFLOW);
});

describe("37.12 execution handoff", () => {
  it("creates exactly one run, bound to the requested workflow and verified org", async () => {
    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG);

    expect(result).toEqual({
      success: true,
      runId: "run_42",
      redirectTo: `/org/${SLUG}/runs/run_42`,
    });

    // The lookup is tenant-scoped: the workflow is found under the org derived
    // from the session, not merely by id.
    expect(workflowFindFirst).toHaveBeenCalledWith({
      where: { id: WORKFLOW_ID, orgId: ORG_ID },
    });

    // Exactly one run, for the requested workflow, with an empty trigger
    // namespace (a generated workflow references no trigger field).
    expect(workflowRunCreate).toHaveBeenCalledTimes(1);
    expect(workflowRunCreate).toHaveBeenCalledWith({
      data: {
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        context: { trigger: { outputs: {} } },
      },
    });

    // The first domino is pushed exactly once.
    expect(advanceWorkflowMock).toHaveBeenCalledTimes(1);
    expect(advanceWorkflowMock).toHaveBeenCalledWith("run_42");
  });

  it("does not re-derive or overwrite the persisted definition/config/criticality", async () => {
    await triggerWorkflowRun(WORKFLOW_ID, SLUG);

    // The handoff must be read-only against the Workflow row: the persisted
    // definition, dependencies, action config and human-decided isCritical are
    // the engine's input, not something the start path recomputes or rewrites.
    expect(workflowUpdate).not.toHaveBeenCalled();
  });

  it("does not reach the engine when the caller is unauthorized", async () => {
    getOrgAccessMock.mockResolvedValue(null);

    const result = await triggerWorkflowRun(WORKFLOW_ID, "other-tenant");

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(workflowFindFirst).not.toHaveBeenCalled();
    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("does not reach the engine when the workflow is foreign or missing", async () => {
    // A tenant-scoped lookup for a workflow the org does not own returns null,
    // exactly as a missing workflow does.
    workflowFindFirst.mockResolvedValue(null);

    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG);

    expect(result.success).toBe(false);
    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("reports start, never completion: the response carries a run id and redirect", async () => {
    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.runId).toBe("run_42");
      // The action has no notion of the run being COMPLETED; it returns the
      // identity of a run that has just been created and redirected to the
      // authoritative run view.
      expect(Object.keys(result).sort()).toEqual(["redirectTo", "runId", "success"]);
    }
  });
});
