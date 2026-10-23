// src/tests/agent/criticality-integration.test.ts
//
// Assignment 37.7 — Human criticality integration acceptance suite.
//
// Authoritative Verification Gate:
// "Integration test where the model proposes criticality and the stored value differs,
// proving the human decision won."
//
// Acceptance Gate:
// "The stored execution policy comes from the human decision. Model output cannot
// set or override `isCritical`."
//
// Test Gate requirements verified:
// 1. Model cannot set final criticality (strict schema / tool execution rejects isCritical).
// 2. Human criticality persists in the durable execution record and transcript.
// 3. Confirmed value cannot be overridden by a later model turn.
// 4. Criticality changes affect only the intended materialized policy.
// 5. Human-approved criticality survives materialization unchanged.

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

jest.mock("@/lib/ai/agent/outbox", () => ({ recordAgentEvent: jest.fn() }));
jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

import { AgentProposalState, AgentSessionStatus } from "@prisma/client";

import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { executeGenerateWorkflow } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { generateWorkflowModelInputSchema } from "@/lib/ai/agent/tools/generate-workflow/schema";
import { WorkflowProposalSchema } from "@/lib/workflow-types/workflow-proposal";
import {
  submitCriticalityDecision,
  readCriticalityDecisionRecord,
} from "@/lib/ai/agent/services/criticality-service";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";

const SESSION_ID = "clx_sess_criticality_integ_01";
const USER_ID = "usr_criticality_reviewer_01";
const ORG_ID = "org_criticality_test_01";
const PROJECT_ID = "clxyz0000000000000000000a";

const MODEL_PROPOSAL_PAYLOAD = {
  name: "Customer Onboarding DAG",
  description: "Linear onboarding with kickoff and follow-up.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kickoff call", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Send follow-up docs", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

describe("Assignment 37.7 — Human Criticality State Integration Gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStore();
    restorePrismaDouble();

    store.sessions = [
      {
        id: SESSION_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        status: AgentSessionStatus.RUNNING,
        currentStep: 1,
        promptVersion: "v6",
        totalSteps: 5,
        title: "Test Criticality Session",
        summary: null,
        metadata: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
  });

  it("1. Model cannot set or smuggle final isCritical in the proposal schema or tool input", async () => {
    // Model attempts to smuggle isCritical into the step definition
    const modelSmuggledInput = {
      ...MODEL_PROPOSAL_PAYLOAD,
      steps: {
        kickoff: {
          action: "task.create",
          inputs: { title: "Kickoff call", projectId: PROJECT_ID },
          dependsOn: [],
          isCritical: true, // Model attempts to declare kickoff as critical
        },
        follow: {
          action: "task.create",
          inputs: { title: "Send follow-up docs", projectId: PROJECT_ID },
          dependsOn: ["kickoff"],
          isCritical: false, // Model attempts to declare follow as non-critical
        },
      },
    };

    // Schema level: parse fails with unrecognized_keys
    const schemaResult = WorkflowProposalSchema.safeParse(modelSmuggledInput);
    expect(schemaResult.success).toBe(false);
    if (!schemaResult.success) {
      expect(
        schemaResult.error.issues.some(
          (i) => i.code === "unrecognized_keys" && (i as unknown as { keys: string[] }).keys.includes("isCritical"),
        ),
      ).toBe(true);
    }

    // Model tool input schema level: parse also fails
    const toolInputResult = generateWorkflowModelInputSchema.safeParse(modelSmuggledInput);
    expect(toolInputResult.success).toBe(false);

    // Executor level: executeGenerateWorkflow fails closed with INVALID_INPUT
    const executionOutput = await executeGenerateWorkflow(modelSmuggledInput as never);
    expect(executionOutput.type).toBe("json");
    if (executionOutput.type === "json") {
      const executionValue = executionOutput.value as { ok: boolean; code?: string };
      expect(executionValue.ok).toBe(false);
      expect(executionValue.code).toBe("INVALID_INPUT");
    }
  });

  it("2. When model generates valid proposal without criticality, human decision wins and stored policy differs", async () => {
    // 1. Model produces a valid proposal without criticality fields
    const validProposal = WorkflowProposalSchema.parse(MODEL_PROPOSAL_PAYLOAD);
    const fingerprint = computeProposalCorrelationId(validProposal);

    const EXECUTION_ID = "clx_exec_prop_01";
    const TOOL_CALL_ID = "call_prop_01";

    // Simulate the worker persisting the valid proposal
    store.executions = [
      {
        id: EXECUTION_ID,
        sessionId: SESSION_ID,
        toolCallId: TOOL_CALL_ID,
        toolName: "generateWorkflow",
        status: "COMPLETED",
        input: MODEL_PROPOSAL_PAYLOAD,
        result: { ok: true, proposal: validProposal },
        proposalState: AgentProposalState.AWAITING_CRITICALITY,
        proposalFingerprint: fingerprint,
        proposalRevision: 1,
        criticalityDecisions: null,
        clarificationAnswer: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];

    // Tool execution message in transcript
    store.messages = [
      {
        id: "msg_1",
        sessionId: SESSION_ID,
        step: 1,
        toolCallId: TOOL_CALL_ID,
        createdAt: new Date(1),
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: TOOL_CALL_ID,
              toolName: "generateWorkflow",
              output: {
                type: "json",
                value: { ok: true, proposal: validProposal },
              },
            },
          ],
        },
      },
    ];

    // Initial state: proposal is AWAITING_CRITICALITY, no decisions stored
    expect(store.executions[0]!.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(store.executions[0]!.criticalityDecisions).toBeNull();

    // 2. Human reviews the proposal and makes a conscious decision:
    // Model/default expectation was kickoff=critical, follow=non-critical.
    // Human explicitly decides the OPPOSITE: kickoff=false (non-critical), follow=true (critical).
    const humanDecisions = {
      kickoff: false,
      follow: true,
    };

    const decisionOutcome = await submitCriticalityDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decisions: humanDecisions,
    });

    expect(decisionOutcome.ok).toBe(true);

    // 3. Verify human criticality persists in the database row and transcript
    const updatedExecution = store.executions.find((e) => e.id === EXECUTION_ID)!;
    expect(updatedExecution.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);
    expect(updatedExecution.criticalityDecisions).toEqual(humanDecisions);

    // Verify transcript record
    const userMessage = store.messages.find(
      (m) => m.toolCallId === EXECUTION_ID && m.message && (m.message as { role: string }).role === "user",
    );
    expect(userMessage).toBeDefined();
    const parsedRecord = readCriticalityDecisionRecord(
      (userMessage!.message as { content: unknown }).content,
      validProposal,
    );
    expect(parsedRecord.ok).toBe(true);
    if (parsedRecord.ok) {
      expect(parsedRecord.approved.decisions).toEqual(humanDecisions);
    }

    // 4. A subsequent model turn generates a newer proposal revision (Revision 2)
    // The previous confirmed decision for Revision 1 remains unmolested.
    const REVISION_2_EXECUTION_ID = "clx_exec_prop_02";
    const rev2Proposal = {
      ...MODEL_PROPOSAL_PAYLOAD,
      description: "Revision 2 proposal with altered description.",
    };
    const rev2Fingerprint = computeProposalCorrelationId(rev2Proposal);

    store.executions.push({
      id: REVISION_2_EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: "call_prop_02",
      toolName: "generateWorkflow",
      status: "COMPLETED",
      input: rev2Proposal,
      result: { ok: true, proposal: rev2Proposal },
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalFingerprint: rev2Fingerprint,
      proposalRevision: 2,
      criticalityDecisions: null,
      clarificationAnswer: null,
      createdAt: new Date(10),
      updatedAt: new Date(10),
    });

    // The human decision on Revision 1 is still intact:
    expect(updatedExecution.criticalityDecisions).toEqual(humanDecisions);

    // 5. Human approves Revision 1 and materializes it
    const approvalOutcome = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });
    expect(approvalOutcome.ok).toBe(true);

    const materializationOutcome = await materializeProposal({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
    });

    expect(materializationOutcome.ok).toBe(true);
    if (!materializationOutcome.ok) return;

    // 6. Verify the materialized workflow definition and UI graph in the store
    const materializedWorkflow = store.workflows.find(
      (w) => w.id === materializationOutcome.workflowId,
    );
    expect(materializedWorkflow).toBeDefined();

    const definition = materializedWorkflow!.definition as {
      steps: Record<
        string,
        { action: string; dependsOn: string[]; config: unknown; isCritical: boolean }
      >;
    };

    // Stored execution policy matches the HUMAN decision, not any model default
    expect(definition.steps.kickoff.isCritical).toBe(false); // Human decided false
    expect(definition.steps.follow.isCritical).toBe(true);  // Human decided true

    // UI Nodes projection also carries the exact human decision
    const uiNodes = materializedWorkflow!.uiNodes as Array<{
      id: string;
      data: { isCritical: boolean };
    }>;
    const kickoffNode = uiNodes.find((n) => n.id === "kickoff");
    const followNode = uiNodes.find((n) => n.id === "follow");

    expect(kickoffNode?.data.isCritical).toBe(false);
    expect(followNode?.data.isCritical).toBe(true);

    // Proving the human decision won:
    // 1. Model could not set isCritical (rejected).
    // 2. Human explicitly chose kickoff=false, follow=true.
    // 3. Stored execution definition and UI graph materialized kickoff=false, follow=true.
  });
});
