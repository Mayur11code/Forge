// src/tests/agent/helpers/proposal-lifecycle-proc-a.realdb.test.ts
//
// Assignment 37.8 (F4) — Process A of Two-Process Restart Survival Harness.
//
// Process A drives the production persistence path (persistExecutionOutcome +
// reconcileActiveProposal), writes a valid proposal awaiting human review to
// real PostgreSQL, records the unique fixture identifiers to disk, and exits.
//
// Process B will independently start in a new OS process, load these records
// using getPendingProposal/submitCriticalityDecision, and advance the lifecycle.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(async (_id: string, cb: () => Promise<unknown>) => cb()),
}));

import fs from "fs";
import path from "path";
import { AgentProposalState, AgentSessionStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/prisma/db";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import {
  persistExecutionOutcome,
  reconcileActiveProposal,
} from "@/lib/ai/agent/services/proposal-service";

jest.setTimeout(60_000);

const TAG = process.env.RESTART_FIXTURE_TAG || `proc_a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const SLUG = `${TAG}_org`;
const EMAIL = `${TAG}@example.invalid`;
const PROJECT_ID = "clxyz0000000000000000000a";

const VALID_PROPOSAL = {
  name: "Restart Survival Workflow",
  description: "A workflow created in Process A to be recovered in Process B.",
  steps: {
    step_init: {
      action: "task.create",
      inputs: { title: "Init Step", projectId: PROJECT_ID },
      dependsOn: [],
    },
    step_review: {
      action: "task.create",
      inputs: { title: "Review Step", projectId: PROJECT_ID },
      dependsOn: ["step_init"],
    },
  },
};

describe("Assignment 37.8 — Process A Persistence Writer", () => {
  it("persists valid proposal to PostgreSQL and exits with fixture manifest", async () => {
    // 1. Create tenant fixture
    const org = await db.organization.create({
      data: { slug: SLUG, name: `${TAG} org` },
      select: { id: true },
    });
    const user = await db.user.create({
      data: { email: EMAIL, name: `${TAG} user` },
      select: { id: true },
    });
    await db.membership.create({
      data: { userId: user.id, orgId: org.id, role: "ADMIN" },
    });

    // 2. Create running agent session
    const session = await db.agentSession.create({
      data: {
        orgId: org.id,
        userId: user.id,
        status: AgentSessionStatus.RUNNING,
        currentStep: 1,
        promptVersion: "v6",
      },
      select: { id: true },
    });

    // 3. Create initial RUNNING tool execution
    const execution = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${TAG}_call_1`,
        toolName: "generateWorkflow",
        input: VALID_PROPOSAL as Prisma.InputJsonValue,
        status: "RUNNING",
      },
      select: { id: true, toolCallId: true },
    });

    // 4. Drive production persistence path (persistExecutionOutcome + reconcileActiveProposal)
    const fingerprint = computeProposalCorrelationId(VALID_PROPOSAL);
    await db.$transaction(async (tx) => {
      const persisted = await persistExecutionOutcome(tx, {
        executionId: execution.id,
        result: { ok: true, proposal: VALID_PROPOSAL },
        lifecycle: {
          state: AgentProposalState.AWAITING_CRITICALITY,
          fingerprint,
        },
        revision: 1,
      });
      expect(persisted).toBe(true);

      const reconciled = await reconcileActiveProposal(tx, {
        sessionId: session.id,
        executionId: execution.id,
        revision: 1,
      });
      expect(reconciled).toBe("active");
    });

    // 5. Add the tool-result message to transcript (needed for criticality decision service)
    await db.agentMessage.create({
      data: {
        sessionId: session.id,
        step: 1,
        toolCallId: execution.toolCallId,
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: execution.toolCallId,
              toolName: "generateWorkflow",
              output: {
                type: "json",
                value: { ok: true, proposal: VALID_PROPOSAL },
              },
            },
          ],
        } as Prisma.InputJsonValue,
      },
    });

    // 6. Create clarification session and execution at NEEDS_CLARIFICATION
    const clarifySession = await db.agentSession.create({
      data: {
        orgId: org.id,
        userId: user.id,
        status: AgentSessionStatus.RUNNING,
        currentStep: 1,
        promptVersion: "v6",
      },
      select: { id: true },
    });
    const clarifyToolCallId = `${TAG}_clarify_call`;
    const clarifyExecution = await db.agentToolExecution.create({
      data: {
        sessionId: clarifySession.id,
        toolCallId: clarifyToolCallId,
        toolName: "generateWorkflow",
        input: {},
        status: "RUNNING",
      },
      select: { id: true, toolCallId: true },
    });
    const clarifyCorrId = `corr_${TAG}_clarify`;
    const clarificationResult = {
      ok: false,
      code: "NEEDS_USER_INPUT",
      status: "NEEDS_USER_INPUT",
      interactionId: clarifyExecution.id,
      correlationId: clarifyCorrId,
      error: "Clarification required",
      fields: [
        { field: "targetEnv", question: "What environment should this target?" },
      ],
    };
    await db.$transaction(async (tx) => {
      const persisted = await persistExecutionOutcome(tx, {
        executionId: clarifyExecution.id,
        result: clarificationResult,
        lifecycle: {
          state: AgentProposalState.NEEDS_CLARIFICATION,
          fingerprint: clarifyCorrId,
        },
        revision: null,
      });
      expect(persisted).toBe(true);
    });
    await db.agentMessage.create({
      data: {
        sessionId: clarifySession.id,
        step: 1,
        toolCallId: clarifyExecution.toolCallId,
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: clarifyExecution.toolCallId,
              toolName: "generateWorkflow",
              output: {
                type: "json",
                value: clarificationResult,
              },
            },
          ],
        } as Prisma.InputJsonValue,
      },
    });

    // 7. Write manifest for Process B
    const manifestPath = path.join(process.cwd(), `fixture-${TAG}.json`);
    const manifest = {
      tag: TAG,
      slug: SLUG,
      email: EMAIL,
      orgId: org.id,
      userId: user.id,
      sessionId: session.id,
      executionId: execution.id,
      toolCallId: execution.toolCallId,
      fingerprint,
      clarifySessionId: clarifySession.id,
      clarifyExecutionId: clarifyExecution.id,
      clarifyCorrId,
      manifestPath,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // Verify row state in PostgreSQL before Process A terminates
    const row = await db.agentToolExecution.findUnique({
      where: { id: execution.id },
      select: { proposalState: true, status: true, proposalRevision: true },
    });
    expect(row?.status).toBe("COMPLETED");
    expect(row?.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(row?.proposalRevision).toBe(1);

    await db.$disconnect();
  });
});
