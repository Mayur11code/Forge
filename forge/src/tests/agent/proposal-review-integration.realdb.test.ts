// src/tests/agent/proposal-review-integration.realdb.test.ts
//
// ASSIGNMENT 37.9 — CONFIRMATION REVIEW INTEGRATION ACCEPTANCE SUITE.
//
// Authoritative Acceptance Gate:
//   "Review surface over existing 35/36 gate. Approval binds exact proposal;
//    changed proposal cannot reuse it."
//
// WHAT THIS SUITE PROVES AGAINST REAL POSTGRESQL:
// -----------------------------------------------
// 1. Pending Proposal Presentation & UI Render:
//    - Persisted AWAITING_APPROVAL proposal row is accurately presented by
//      GET /api/agent/session/[sessionId] with Kahn-ordered steps, metadata,
//      revision, and validated approvedCriticality decisions.
//    - ProposalReviewCard renders server-side (renderToStaticMarkup) with
//      actionable "Approve" and "Decline" controls and correct review details.
//
// 2. Proposal Approval & Authoritative UI Refresh:
//    - Real POST .../proposal-approval route atomically executes CAS transition
//      to APPROVED and writes the forge:proposal-decision:v1 audit message.
//    - Rereading GET /api/agent/session/[sessionId] clears pendingProposal and
//      surfaces proposalOutcome at APPROVED.
//    - ProposalReviewCard re-renders to an approved state ("Approved", "Create
//      workflow" CTA, action buttons removed).
//    - Repeat approval is idempotent.
//
// 3. Proposal Decline & Reversal Rejection:
//    - Real POST .../proposal-decline route atomically transitions to DECLINED.
//    - Rereading GET surfaces proposalOutcome at DECLINED.
//    - ProposalReviewCard re-renders with "Declined" banner and explanation.
//    - Subsequent approval attempt returns 409 PROPOSAL_ALREADY_DECIDED.
//    - Repeat decline is idempotent.
//
// 4. Revision Binding & Supersession Safety:
//    - Superseded proposal revision cannot be approved (409 PROPOSAL_NOT_AWAITING_APPROVAL).
//    - Authoritative GET exposes only the active revision.
//    - Approval binds strictly to the active revision.
//
// 5. Review Expiry & Rejection:
//    - expireStaleProposalReviews sweeps past-due proposals (AWAITING_APPROVAL -> EXPIRED).
//    - Authoritative GET exposes proposalOutcome at EXPIRED.
//    - ProposalReviewCard re-renders with "Review window closed" notice.
//    - Attempted approval of expired proposal returns 409 PROPOSAL_EXPIRED.
//
// Run with:
//   npx jest --config jest.realdb.config.ts src/tests/agent/proposal-review-integration.realdb.test.ts

jest.mock("server-only", () => ({}));

const authMock = jest.fn();
jest.mock("@/lib/auth/auth", () => ({
  auth: () => authMock(),
}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn((_sessionId: string, fn: () => Promise<unknown>) => fn()),
}));

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentProposalState,
  AgentSessionStatus,
  type Prisma,
} from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { reconcileActiveProposal } from "@/lib/ai/agent/services/proposal-service";
import { expireStaleProposalReviews } from "@/lib/ai/agent/reaper";
import { ProposalReviewCard } from "@/features/organizations/components/ai/ProposalReviewCard";

import { GET as getSessionRoute } from "@/app/api/agent/session/[sessionId]/route";
import { POST as approveRoute } from "@/app/api/agent/session/[sessionId]/proposal-approval/route";
import { POST as declineRoute } from "@/app/api/agent/session/[sessionId]/proposal-decline/route";

jest.setTimeout(120_000);

const RUN_TAG = `revint_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const ORG_SLUG = `${RUN_TAG}_org`;
const USER_EMAIL = `${RUN_TAG}@example.invalid`;
const PROJECT_ID = "clxyz0000000000000000000a";

const PROPOSAL_V1 = {
  name: "Onboard a client",
  description: "Kick off client onboarding workflow.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off client", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up with client", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

const PROPOSAL_V2 = {
  name: "Onboard a client v2",
  description: "Revised client onboarding with notification.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off client v2", projectId: PROJECT_ID },
      dependsOn: [],
    },
    notify: {
      action: "task.create",
      inputs: { title: "Notify stakeholders", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up with client v2", projectId: PROJECT_ID },
      dependsOn: ["notify"],
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

  // Default auth mock returns primary user
  authMock.mockResolvedValue({ user: { id: primaryUserId } });
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

    // Zero leftover rows assertion
    const [leftoverSessions, leftoverExecs, leftoverMessages, leftoverOrgs, leftoverUsers] =
      await Promise.all([
        db.agentSession.count({ where: { orgId: { in: trackedOrgIds } } }),
        db.agentToolExecution.count({ where: { sessionId: { in: trackedSessionIds } } }),
        db.agentMessage.count({ where: { sessionId: { in: trackedSessionIds } } }),
        db.organization.count({ where: { id: { in: trackedOrgIds } } }),
        db.user.count({ where: { id: { in: trackedUserIds } } }),
      ]);

    expect({
      leftoverSessions,
      leftoverExecs,
      leftoverMessages,
      leftoverOrgs,
      leftoverUsers,
    }).toEqual({
      leftoverSessions: 0,
      leftoverExecs: 0,
      leftoverMessages: 0,
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

function callGetSession(sessionId: string) {
  return getSessionRoute(
    new Request(`http://localhost/api/agent/session/${sessionId}`),
    { params: Promise.resolve({ sessionId }) },
  );
}

function callApprove(sessionId: string, body: unknown) {
  return approveRoute(
    new Request(
      `http://localhost/api/agent/session/${sessionId}/proposal-approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ sessionId }) },
  );
}

function callDecline(sessionId: string, body: unknown) {
  return declineRoute(
    new Request(
      `http://localhost/api/agent/session/${sessionId}/proposal-decline`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ sessionId }) },
  );
}

describe("Assignment 37.9 — Confirmation Review Integration Acceptance", () => {
  // -------------------------------------------------------------------------
  // 1. Pending Proposal Presentation & UI Render
  // -------------------------------------------------------------------------
  it("presents pending proposal with review model and renders actionable ProposalReviewCard", async () => {
    const session = await createSession();
    const fp = computeProposalCorrelationId(PROPOSAL_V1);
    const deadline = new Date(Date.now() + 3_600_000);

    const execution = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_pres_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V1 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp,
        proposalRevision: 1,
        criticalityDecisions: { kickoff: false, follow: true } as Prisma.InputJsonValue,
        expiresAt: deadline,
      },
      select: { id: true },
    });

    // Authoritative session read route
    const res = await callGetSession(session.id);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.pendingProposal).not.toBeNull();
    expect(data.pendingProposal.interactionId).toBe(execution.id);
    expect(data.pendingProposal.state).toBe("AWAITING_APPROVAL");
    expect(data.pendingProposal.revision).toBe(1);
    expect(data.pendingProposal.fingerprint).toBe(fp);
    expect(data.pendingProposal.approvedCriticality).toEqual({ kickoff: false, follow: true });

    // Review model verification
    const review = data.pendingProposal.review;
    expect(review).not.toBeNull();
    expect(review.name).toBe("Onboard a client");
    expect(review.description).toBe("Kick off client onboarding workflow.");
    expect(review.stepCount).toBe(2);
    expect(review.order).toEqual(["kickoff", "follow"]);
    expect(review.steps.map((s: { ref: string }) => s.ref)).toEqual(["follow", "kickoff"]);
    expect(review.criticality).toEqual({ kickoff: false, follow: true });

    // UI Render via React SSR (renderToStaticMarkup)
    const cardElement = React.createElement(ProposalReviewCard, {
      sessionId: session.id,
      interactionId: execution.id,
      state: data.pendingProposal.state,
      review,
    });
    const html = renderToStaticMarkup(cardElement);

    // Verify UI contains proposal review elements and action buttons
    expect(html).toContain("Onboard a client");
    expect(html).toContain("Kick off client onboarding workflow.");
    expect(html).toContain("Awaiting your review");
    expect(html).toContain("2 steps");
    expect(html).toContain("kickoff");
    expect(html).toContain("follow");
    expect(html).toContain("task.create");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Decline<");
  });

  // -------------------------------------------------------------------------
  // 2. Proposal Approval & Authoritative UI Refresh
  // -------------------------------------------------------------------------
  it("approves proposal via POST, updates DB & transcript, and re-renders to approved state", async () => {
    const session = await createSession();
    const fp = computeProposalCorrelationId(PROPOSAL_V1);
    const deadline = new Date(Date.now() + 3_600_000);

    const execution = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_appr_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V1 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp,
        proposalRevision: 1,
        criticalityDecisions: { kickoff: true, follow: false } as Prisma.InputJsonValue,
        expiresAt: deadline,
      },
      select: { id: true, toolCallId: true },
    });

    // 1. Submit approval via POST route
    const approveRes = await callApprove(session.id, { interactionId: execution.id });
    expect(approveRes.status).toBe(200);

    const approveJson = await approveRes.json();
    expect(approveJson).toEqual({
      sessionId: session.id,
      step: 1,
      state: "APPROVED",
      status: "ACCEPTED",
    });

    // 2. Direct PostgreSQL verification
    const dbRow = await db.agentToolExecution.findUnique({
      where: { id: execution.id },
      select: { proposalState: true },
    });
    expect(dbRow?.proposalState).toBe(AgentProposalState.APPROVED);

    // Audit message in AgentMessage transcript (toolCallId records interactionId)
    const auditMessage = await db.agentMessage.findFirst({
      where: {
        sessionId: session.id,
        toolCallId: execution.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditMessage).not.toBeNull();
    const auditPayload = auditMessage?.message as { role?: string; content?: string } | null;
    expect(auditPayload?.role).toBe("user");
    expect(auditPayload?.content).toContain("forge:proposal-decision:v1");
    expect(auditPayload?.content).toContain(`proposal: ${fp}`);
    expect(auditPayload?.content).toContain("decision: approved");

    // 3. Authoritative Session Reread
    const readRes = await callGetSession(session.id);
    expect(readRes.status).toBe(200);

    const readData = await readRes.json();
    expect(readData.pendingProposal).toBeNull();
    expect(readData.proposalOutcome).not.toBeNull();
    expect(readData.proposalOutcome.state).toBe("APPROVED");
    expect(readData.proposalOutcome.interactionId).toBe(execution.id);

    // 4. UI Re-render from authoritative outcome
    const approvedCardElement = React.createElement(ProposalReviewCard, {
      sessionId: session.id,
      interactionId: execution.id,
      state: readData.proposalOutcome.state,
      review: readData.proposalOutcome.review,
    });
    const approvedHtml = renderToStaticMarkup(approvedCardElement);

    // Verify approved UI elements
    expect(approvedHtml).toContain("Approved");
    expect(approvedHtml).toContain("This proposal was approved. Create the workflow to save it to your organization.");
    expect(approvedHtml).toContain("Create workflow");
    // Action buttons are no longer rendered
    expect(approvedHtml).not.toContain(">Approve<");
    expect(approvedHtml).not.toContain(">Decline<");

    // 5. Repeat approval is idempotent
    const repeatRes = await callApprove(session.id, { interactionId: execution.id });
    expect(repeatRes.status).toBe(200);
    const repeatJson = await repeatRes.json();
    expect(repeatJson).toMatchObject({
      sessionId: session.id,
      state: "APPROVED",
      status: "ACCEPTED",
      idempotent: true,
    });
  });

  // -------------------------------------------------------------------------
  // 3. Proposal Decline & Reversal Rejection
  // -------------------------------------------------------------------------
  it("declines proposal via POST, updates DB, re-renders to declined state, and rejects reversal", async () => {
    const session = await createSession();
    const fp = computeProposalCorrelationId(PROPOSAL_V1);

    const execution = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_decl_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V1 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp,
        proposalRevision: 1,
        criticalityDecisions: { kickoff: false, follow: false } as Prisma.InputJsonValue,
      },
      select: { id: true, toolCallId: true },
    });

    // 1. Submit decline via POST route
    const declineRes = await callDecline(session.id, { interactionId: execution.id });
    expect(declineRes.status).toBe(200);

    const declineJson = await declineRes.json();
    expect(declineJson).toEqual({
      sessionId: session.id,
      step: 1,
      state: "DECLINED",
      status: "ACCEPTED",
    });

    // 2. Direct DB verification
    const dbRow = await db.agentToolExecution.findUnique({
      where: { id: execution.id },
      select: { proposalState: true },
    });
    expect(dbRow?.proposalState).toBe(AgentProposalState.DECLINED);

    // Audit message verification (toolCallId records interactionId)
    const auditMessage = await db.agentMessage.findFirst({
      where: {
        sessionId: session.id,
        toolCallId: execution.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditMessage).not.toBeNull();
    const auditPayload = auditMessage?.message as { role?: string; content?: string } | null;
    expect(auditPayload?.role).toBe("user");
    expect(auditPayload?.content).toContain("forge:proposal-decision:v1");
    expect(auditPayload?.content).toContain("decision: declined");

    // 3. Authoritative Session Reread
    const readRes = await callGetSession(session.id);
    const readData = await readRes.json();
    expect(readData.pendingProposal).toBeNull();
    expect(readData.proposalOutcome.state).toBe("DECLINED");

    // 4. UI Re-render to declined state
    const declinedCardElement = React.createElement(ProposalReviewCard, {
      sessionId: session.id,
      interactionId: execution.id,
      state: readData.proposalOutcome.state,
      review: readData.proposalOutcome.review,
    });
    const declinedHtml = renderToStaticMarkup(declinedCardElement);

    expect(declinedHtml).toContain("Declined");
    expect(declinedHtml).toContain("You declined this proposal. No workflow was created.");
    expect(declinedHtml).not.toContain(">Approve<");
    expect(declinedHtml).not.toContain(">Decline<");
    expect(declinedHtml).not.toContain("Create workflow");

    // 5. Subsequent approval attempt is rejected with 409 PROPOSAL_ALREADY_DECIDED
    const conflictRes = await callApprove(session.id, { interactionId: execution.id });
    expect(conflictRes.status).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.code).toBe("PROPOSAL_ALREADY_DECIDED");

    // 6. Repeat decline is idempotent
    const repeatDeclineRes = await callDecline(session.id, { interactionId: execution.id });
    expect(repeatDeclineRes.status).toBe(200);
    const repeatDeclineJson = await repeatDeclineRes.json();
    expect(repeatDeclineJson).toMatchObject({
      sessionId: session.id,
      state: "DECLINED",
      status: "ACCEPTED",
      idempotent: true,
    });
  });

  // -------------------------------------------------------------------------
  // 4. Revision Binding & Supersession Safety
  // -------------------------------------------------------------------------
  it("rejects approval on superseded proposal revision and exposes only the active revision", async () => {
    const session = await createSession();
    const fp1 = computeProposalCorrelationId(PROPOSAL_V1);
    const fp2 = computeProposalCorrelationId(PROPOSAL_V2);

    // Revision 1
    const exec1 = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_rev1_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V1 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp1,
        proposalRevision: 1,
        criticalityDecisions: { kickoff: false, follow: false } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Revision 2
    const exec2 = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_rev2_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V2 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp2,
        proposalRevision: 2,
        criticalityDecisions: { kickoff: true, notify: false, follow: true } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Reconcile Revision 2 (supersedes Revision 1)
    await db.$transaction(async (tx) => {
      const outcome = await reconcileActiveProposal(tx, {
        sessionId: session.id,
        executionId: exec2.id,
        revision: 2,
      });
      expect(outcome).toBe("active");
    });

    const row1 = await db.agentToolExecution.findUnique({
      where: { id: exec1.id },
      select: { proposalState: true },
    });
    expect(row1?.proposalState).toBe(AgentProposalState.SUPERSEDED);

    // Attempting to approve Revision 1 is rejected with 409 PROPOSAL_NOT_AWAITING_APPROVAL
    const approveStaleRes = await callApprove(session.id, { interactionId: exec1.id });
    expect(approveStaleRes.status).toBe(409);
    const approveStaleJson = await approveStaleRes.json();
    expect(approveStaleJson.code).toBe("PROPOSAL_NOT_AWAITING_APPROVAL");

    // Authoritative session read surfaces only Revision 2 in pendingProposal
    const readRes = await callGetSession(session.id);
    const readData = await readRes.json();
    expect(readData.pendingProposal).not.toBeNull();
    expect(readData.pendingProposal.interactionId).toBe(exec2.id);
    expect(readData.pendingProposal.revision).toBe(2);
    expect(readData.pendingProposal.fingerprint).toBe(fp2);
    expect(readData.pendingProposal.review.name).toBe("Onboard a client v2");

    // Approving Revision 2 succeeds
    const approveRev2Res = await callApprove(session.id, { interactionId: exec2.id });
    expect(approveRev2Res.status).toBe(200);
    const approveRev2Json = await approveRev2Res.json();
    expect(approveRev2Json.state).toBe("APPROVED");
  });

  // -------------------------------------------------------------------------
  // 5. Review Expiry & Rejection
  // -------------------------------------------------------------------------
  it("expires past-due proposal review, surfaces EXPIRED in UI, and rejects subsequent approval", async () => {
    const session = await createSession();
    const fp = computeProposalCorrelationId(PROPOSAL_V1);
    const pastDeadline = new Date(Date.now() - 30_000);

    const execution = await db.agentToolExecution.create({
      data: {
        sessionId: session.id,
        toolCallId: `${RUN_TAG}_exp_call`,
        toolName: "generateWorkflow",
        input: {},
        status: "COMPLETED",
        result: { ok: true, proposal: PROPOSAL_V1 } as Prisma.InputJsonValue,
        proposalState: AgentProposalState.AWAITING_APPROVAL,
        proposalFingerprint: fp,
        proposalRevision: 1,
        criticalityDecisions: { kickoff: false, follow: false } as Prisma.InputJsonValue,
        expiresAt: pastDeadline,
      },
      select: { id: true },
    });

    // Run reaper sweep
    const sweepResult = await expireStaleProposalReviews({
      now: new Date(),
    });
    expect(sweepResult.expired).toBeGreaterThanOrEqual(1);

    // Verify DB transition
    const dbRow = await db.agentToolExecution.findUnique({
      where: { id: execution.id },
      select: { proposalState: true },
    });
    expect(dbRow?.proposalState).toBe(AgentProposalState.EXPIRED);

    // Authoritative session reread surfaces EXPIRED
    const readRes = await callGetSession(session.id);
    const readData = await readRes.json();
    expect(readData.pendingProposal).toBeNull();
    expect(readData.proposalOutcome).not.toBeNull();
    expect(readData.proposalOutcome.state).toBe("EXPIRED");

    // UI Re-render to expired state
    const expiredCardElement = React.createElement(ProposalReviewCard, {
      sessionId: session.id,
      interactionId: execution.id,
      state: readData.proposalOutcome.state,
      review: readData.proposalOutcome.review,
    });
    const expiredHtml = renderToStaticMarkup(expiredCardElement);

    expect(expiredHtml).toContain("Review window closed");
    expect(expiredHtml).toContain("The review window closed before this proposal was decided.");
    expect(expiredHtml).not.toContain(">Approve<");
    expect(expiredHtml).not.toContain(">Decline<");

    // Approval attempt on expired proposal returns 409 PROPOSAL_EXPIRED
    const approveExpiredRes = await callApprove(session.id, { interactionId: execution.id });
    expect(approveExpiredRes.status).toBe(409);
    const approveExpiredJson = await approveExpiredRes.json();
    expect(approveExpiredJson.code).toBe("PROPOSAL_EXPIRED");
  });
});
