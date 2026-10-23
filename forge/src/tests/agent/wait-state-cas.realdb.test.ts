// src/tests/agent/wait-state-cas.realdb.test.ts
//
// ASSIGNMENT 37.14 — REAL-POSTGRESQL WAIT-STATE CAS & EXPIRY ISOLATION SUITE.
//
// Authoritative Acceptance Gates:
//   1. Three distinct loops:
//      - Model self-correction: model corrects without parking; session stays RUNNING.
//      - Human clarification: missing input parks at WAITING_CONFIRMATION; answer clears to
//        RUNNING and records AGENT_LOOP_REQUESTED outbox intent.
//      - Human proposal confirmation: pending proposal parks at WAITING_CONFIRMATION; decision
//        clears to RUNNING without model continuation.
//   2. Wait-state CAS safety:
//      - Stale/cancelled session cannot be parked or cleared (cannot resurrect).
//   3. Proposal-review expiry isolation (Reaper check):
//      - Sole proposal expiry clears WAITING_CONFIRMATION -> RUNNING with zero outbox events.
//      - Competing human waits (pending clarification, another proposal, or tool confirmation)
//        prevent the session wait from clearing.
//      - Expiring proposal is excluded from competing wait count.
//
// Run with:
//   npx jest --config jest.realdb.config.ts src/tests/agent/wait-state-cas.realdb.test.ts

jest.mock("server-only", () => ({}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn((_sessionId: string, fn: () => Promise<unknown>) => fn()),
}));

import {
  AgentProposalState,
  AgentSessionStatus,
  AgentToolExecutionStatus,
  type Prisma,
} from "@prisma/client";

import { db } from "@/lib/prisma/db";
import {
  markAgentSessionWaiting,
  clearAgentSessionWaiting,
  cancelAgentSession,
} from "@/lib/ai/agent/session-service";
import { submitClarificationAnswer } from "@/lib/ai/agent/services/clarification-service";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";
import { expireStaleProposalReviews } from "@/lib/ai/agent/reaper";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";

jest.setTimeout(120_000);

const RUN_TAG = `waitcas_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const ORG_SLUG = `${RUN_TAG}_org`;
const USER_EMAIL = `${RUN_TAG}@example.invalid`;
const PROJECT_ID = "clxyz0000000000000000000a";

const SAMPLE_PROPOSAL = {
  name: "Wait State CAS Workflow",
  description: "Tests durable wait-state transitions and expiry isolation.",
  steps: {
    init: {
      action: "task.create",
      inputs: { title: "Initialization", projectId: PROJECT_ID },
      dependsOn: [],
    },
  },
};

let primaryOrgId: string;
let primaryUserId: string;

const trackedSessionIds: string[] = [];
const trackedOrgIds: string[] = [];
const trackedUserIds: string[] = [];

beforeAll(async () => {
  const org = await db.organization.create({
    data: { slug: ORG_SLUG, name: `${RUN_TAG} org` },
    select: { id: true },
  });
  primaryOrgId = org.id;
  trackedOrgIds.push(org.id);

  const user = await db.user.create({
    data: { email: USER_EMAIL, name: `${RUN_TAG} user` },
    select: { id: true },
  });
  primaryUserId = user.id;
  trackedUserIds.push(user.id);

  await db.membership.create({
    data: { userId: primaryUserId, orgId: primaryOrgId, role: "ADMIN" },
  });
});

afterAll(async () => {
  try {
    if (trackedSessionIds.length > 0) {
      await db.agentMessage.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
      });
      await db.agentOutboxEvent.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
      });
      await db.agentToolExecution.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
      });
      await db.workflow.deleteMany({
        where: { orgId: { in: trackedOrgIds } },
      });
      await db.agentSession.deleteMany({
        where: { id: { in: trackedSessionIds } },
      });
    }

    if (trackedOrgIds.length > 0) {
      await db.membership.deleteMany({
        where: { orgId: { in: trackedOrgIds } },
      });
      await db.organization.deleteMany({
        where: { id: { in: trackedOrgIds } },
      });
    }

    if (trackedUserIds.length > 0) {
      await db.user.deleteMany({
        where: { id: { in: trackedUserIds } },
      });
    }

    const [leftoverSessions, leftoverExecs, leftoverMessages, leftoverOutbox, leftoverOrgs, leftoverUsers] =
      await Promise.all([
        db.agentSession.count({ where: { orgId: { in: trackedOrgIds } } }),
        db.agentToolExecution.count({ where: { sessionId: { in: trackedSessionIds } } }),
        db.agentMessage.count({ where: { sessionId: { in: trackedSessionIds } } }),
        db.agentOutboxEvent.count({ where: { sessionId: { in: trackedSessionIds } } }),
        db.organization.count({ where: { id: { in: trackedOrgIds } } }),
        db.user.count({ where: { id: { in: trackedUserIds } } }),
      ]);

    expect({
      leftoverSessions,
      leftoverExecs,
      leftoverMessages,
      leftoverOutbox,
      leftoverOrgs,
      leftoverUsers,
    }).toEqual({
      leftoverSessions: 0,
      leftoverExecs: 0,
      leftoverMessages: 0,
      leftoverOutbox: 0,
      leftoverOrgs: 0,
      leftoverUsers: 0,
    });
  } finally {
    await db.$disconnect();
  }
});

async function createSession(
  overrides: Partial<Prisma.AgentSessionUncheckedCreateInput> = {},
) {
  const session = await db.agentSession.create({
    data: {
      orgId: primaryOrgId,
      userId: primaryUserId,
      status: AgentSessionStatus.RUNNING,
      currentStep: 1,
      promptVersion: "v6",
      ...overrides,
    },
    select: { id: true, orgId: true, userId: true },
  });
  trackedSessionIds.push(session.id);
  return session;
}

describe("Assignment 37.14 — Durable Wait-State CAS & Expiry Isolation (Real PostgreSQL)", () => {
  // -------------------------------------------------------------------------
  // 1. Clarification Lifecycle (Loop 2)
  // -------------------------------------------------------------------------
  describe("1. Clarification Lifecycle & Wait-State CAS", () => {
    it("parks session at WAITING_CONFIRMATION on clarification requirement, then clears on answer and records outbox intent", async () => {
      const session = await createSession();
      const corrId = `corr_${RUN_TAG}_1`;

      // 1. Seed execution at RUNNING and record clarification requirement
      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_clarify_call_1`,
          toolName: "generateWorkflow",
          status: "RUNNING",
          input: {},
          proposalState: AgentProposalState.NEEDS_CLARIFICATION,
        },
        select: { id: true, toolCallId: true },
      });

      const clarificationResult = {
        ok: false,
        code: "NEEDS_USER_INPUT",
        status: "NEEDS_USER_INPUT",
        interactionId: execution.id,
        correlationId: corrId,
        error: "Missing required inputs",
        fields: [
          { field: "targetEnv", question: "What environment should this target?" },
        ],
      };

      await db.agentToolExecution.update({
        where: { id: execution.id },
        data: {
          result: clarificationResult as Prisma.InputJsonValue,
          proposalFingerprint: corrId,
        },
      });

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
                  value: clarificationResult,
                },
              },
            ],
          } as Prisma.InputJsonValue,
        },
      });

      // 2. Park session at WAITING_CONFIRMATION (CAS from RUNNING)
      const parkResult = await markAgentSessionWaiting(session.id);
      expect(parkResult.count).toBe(1);

      // Verify persisted session state in PostgreSQL
      const parkedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(parkedSession?.status).toBe(AgentSessionStatus.WAITING_CONFIRMATION);

      // 3. Submit human clarification answer
      const answerResult = await submitClarificationAnswer({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        correlationId: corrId,
        answers: { targetEnv: "production" },
      });
      expect(answerResult.ok).toBe(true);

      // 4. Verify wait cleared back to RUNNING and continuation intent recorded
      const resumedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(resumedSession?.status).toBe(AgentSessionStatus.RUNNING);

      const updatedExec = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: { proposalState: true, clarificationAnswer: true },
      });
      expect(updatedExec?.proposalState).toBe(AgentProposalState.CLARIFICATION_ACCEPTED);
      expect(updatedExec?.clarificationAnswer).toEqual({ targetEnv: "production" });

      // Outbox continuation intent was recorded in same tx
      const outboxEvent = await db.agentOutboxEvent.findFirst({
        where: {
          sessionId: session.id,
          eventType: "AGENT_LOOP_REQUESTED",
        },
      });
      expect(outboxEvent).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Proposal Decision Lifecycle (Loop 3)
  // -------------------------------------------------------------------------
  describe("2. Proposal Decision Lifecycle & Wait-State CAS", () => {
    it("parks session at WAITING_CONFIRMATION on pending proposal, clears on approval, and emits zero loop events", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_appr_call_1`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // Park session
      const parkResult = await markAgentSessionWaiting(session.id);
      expect(parkResult.count).toBe(1);

      const parkedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(parkedSession?.status).toBe(AgentSessionStatus.WAITING_CONFIRMATION);

      // Approve proposal
      const decisionResult = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(decisionResult.ok).toBe(true);

      // Wait cleared to RUNNING
      const clearedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(clearedSession?.status).toBe(AgentSessionStatus.RUNNING);

      const approvedExec = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: { proposalState: true },
      });
      expect(approvedExec?.proposalState).toBe(AgentProposalState.APPROVED);

      // Decision does NOT emit AGENT_LOOP_REQUESTED
      const outboxEvent = await db.agentOutboxEvent.findFirst({
        where: {
          sessionId: session.id,
          eventType: "AGENT_LOOP_REQUESTED",
        },
      });
      expect(outboxEvent).toBeNull();
    });

    it("clears session wait on decline and emits zero loop events", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_decl_call_1`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      await markAgentSessionWaiting(session.id);

      // Decline proposal
      const declineResult = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decision: AgentProposalState.DECLINED,
      });
      expect(declineResult.ok).toBe(true);

      const clearedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(clearedSession?.status).toBe(AgentSessionStatus.RUNNING);

      const outboxEvent = await db.agentOutboxEvent.findFirst({
        where: {
          sessionId: session.id,
          eventType: "AGENT_LOOP_REQUESTED",
        },
      });
      expect(outboxEvent).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Contested & Terminal State Invariants
  // -------------------------------------------------------------------------
  describe("3. Contested & Stale CAS Transitions", () => {
    it("refuses to park or clear a CANCELLED session and prevents resurrection", async () => {
      const session = await createSession();

      // Cancel session
      const cancelResult = await cancelAgentSession(
        session.id,
        primaryOrgId,
        primaryUserId,
      );
      expect(cancelResult.count).toBe(1);

      // Attempting to park a cancelled session returns count 0 (CAS matches RUNNING only)
      const parkAttempt = await markAgentSessionWaiting(session.id);
      expect(parkAttempt.count).toBe(0);

      // Attempting to clear a cancelled session returns count 0 (CAS matches WAITING_CONFIRMATION only)
      const clearAttempt = await clearAgentSessionWaiting(session.id);
      expect(clearAttempt.count).toBe(0);

      const finalSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(finalSession?.status).toBe(AgentSessionStatus.CANCELLED);
    });

    it("rejects proposal decision on a CANCELLED session with 409 SESSION_NOT_RUNNING", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_term_call_1`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      await cancelAgentSession(session.id, primaryOrgId, primaryUserId);

      const decisionResult = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decision: AgentProposalState.APPROVED,
      });

      expect(decisionResult).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "SESSION_NOT_RUNNING",
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Proposal-Review Expiry Isolation (Reaper Sweep)
  // -------------------------------------------------------------------------
  describe("4. Proposal-Review Expiry Isolation", () => {
    it("Case 4A: Clean expiry clears session wait when no other human-wait exists", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);
      const pastDeadline = new Date(Date.now() - 30_000);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_exp_sole_call`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
          expiresAt: pastDeadline,
        },
        select: { id: true },
      });

      await markAgentSessionWaiting(session.id);

      // Run reaper sweep
      const sweep = await expireStaleProposalReviews({ now: new Date() });
      expect(sweep.expired).toBeGreaterThanOrEqual(1);

      // Verify row is EXPIRED
      const updatedExec = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: { proposalState: true },
      });
      expect(updatedExec?.proposalState).toBe(AgentProposalState.EXPIRED);

      // Session wait is cleared to RUNNING because no other human waits exist
      const updatedSession = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(updatedSession?.status).toBe(AgentSessionStatus.RUNNING);

      // Zero outbox loop events emitted on expiry
      const outbox = await db.agentOutboxEvent.findFirst({
        where: { sessionId: session.id, eventType: "AGENT_LOOP_REQUESTED" },
      });
      expect(outbox).toBeNull();
    });

    it("Case 4B: Expiry does NOT clear session wait when a clarification is still pending (Isolation)", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);
      const pastDeadline = new Date(Date.now() - 30_000);

      // Expiring proposal
      const execProposal = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_exp_comp_prop`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
          expiresAt: pastDeadline,
        },
        select: { id: true },
      });

      // Competing pending clarification
      const execClarification = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_comp_clarify`,
          toolName: "generateWorkflow",
          input: {},
          status: "RUNNING",
          proposalState: AgentProposalState.NEEDS_CLARIFICATION,
        },
        select: { id: true },
      });

      await markAgentSessionWaiting(session.id);

      // Run reaper sweep
      const sweep = await expireStaleProposalReviews({ now: new Date() });
      expect(sweep.expired).toBeGreaterThanOrEqual(1);

      // Proposal transitioned to EXPIRED
      const rowProposal = await db.agentToolExecution.findUnique({
        where: { id: execProposal.id },
        select: { proposalState: true },
      });
      expect(rowProposal?.proposalState).toBe(AgentProposalState.EXPIRED);

      // Clarification is still pending
      const rowClarify = await db.agentToolExecution.findUnique({
        where: { id: execClarification.id },
        select: { proposalState: true },
      });
      expect(rowClarify?.proposalState).toBe(AgentProposalState.NEEDS_CLARIFICATION);

      // ISOLATION: Session status MUST REMAIN WAITING_CONFIRMATION!
      const sessionCheck = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(sessionCheck?.status).toBe(AgentSessionStatus.WAITING_CONFIRMATION);

      // Zero continuation events emitted
      const outbox = await db.agentOutboxEvent.findFirst({
        where: { sessionId: session.id, eventType: "AGENT_LOOP_REQUESTED" },
      });
      expect(outbox).toBeNull();
    });

    it("Case 4C: Expiry does NOT clear session wait when another proposal is still pending review (Isolation)", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);
      const pastDeadline = new Date(Date.now() - 30_000);
      const futureDeadline = new Date(Date.now() + 3_600_000);

      // Expiring proposal (due)
      const execDue = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_exp_due_prop`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
          expiresAt: pastDeadline,
        },
        select: { id: true },
      });

      // Another proposal (future, not due)
      const execFuture = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_exp_future_prop`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 2,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
          expiresAt: futureDeadline,
        },
        select: { id: true },
      });

      await markAgentSessionWaiting(session.id);

      const sweep = await expireStaleProposalReviews({ now: new Date() });
      expect(sweep.expired).toBeGreaterThanOrEqual(1);

      const rowDue = await db.agentToolExecution.findUnique({
        where: { id: execDue.id },
        select: { proposalState: true },
      });
      expect(rowDue?.proposalState).toBe(AgentProposalState.EXPIRED);

      const rowFuture = await db.agentToolExecution.findUnique({
        where: { id: execFuture.id },
        select: { proposalState: true },
      });
      expect(rowFuture?.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);

      // ISOLATION: Session remains WAITING_CONFIRMATION due to unexpired proposal
      const sessionCheck = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(sessionCheck?.status).toBe(AgentSessionStatus.WAITING_CONFIRMATION);
    });

    it("Case 4D: Expiry does NOT clear session wait when a tool execution is PENDING_CONFIRMATION", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);
      const pastDeadline = new Date(Date.now() - 30_000);

      // Expiring proposal
      const execDue = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_exp_toolconf_prop`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: false } as Prisma.InputJsonValue,
          expiresAt: pastDeadline,
        },
        select: { id: true },
      });

      // Competing tool confirmation
      const execToolConfirm = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_tool_pending_conf`,
          toolName: "task.create",
          input: { title: "Requires human confirm" },
          status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
        },
        select: { id: true },
      });

      await markAgentSessionWaiting(session.id);

      const sweep = await expireStaleProposalReviews({ now: new Date() });
      expect(sweep.expired).toBeGreaterThanOrEqual(1);

      const rowDue = await db.agentToolExecution.findUnique({
        where: { id: execDue.id },
        select: { proposalState: true },
      });
      expect(rowDue?.proposalState).toBe(AgentProposalState.EXPIRED);

      const rowTool = await db.agentToolExecution.findUnique({
        where: { id: execToolConfirm.id },
        select: { status: true },
      });
      expect(rowTool?.status).toBe(AgentToolExecutionStatus.PENDING_CONFIRMATION);

      // ISOLATION: Session remains WAITING_CONFIRMATION due to pending tool confirmation
      const sessionCheck = await db.agentSession.findUnique({
        where: { id: session.id },
        select: { status: true },
      });
      expect(sessionCheck?.status).toBe(AgentSessionStatus.WAITING_CONFIRMATION);
    });
  });
});
