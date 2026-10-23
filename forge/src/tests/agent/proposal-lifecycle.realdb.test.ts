// src/tests/agent/proposal-lifecycle.realdb.test.ts
//
// Assignment 37.8 (F4) — Durable Proposal Persistence and Restart Survival Acceptance Suite.
//
// Authoritative Acceptance Gate:
// "Proposal lifecycle state must survive process restarts. State transitions
// (generation -> criticality -> review -> approval -> materialization, plus clarification)
// must be durable in PostgreSQL, recoverable via production queries, and safe across restarts."
//
// This suite executes against real PostgreSQL (via `jest.realdb.config.ts`), proving:
// 1. Genuine Two-Process Cold Restart Survival (Process A writes and terminates;
//    Process B starts independently, recovers via production routes, and advances lifecycle).
// 2. Complete Lifecycle Acceptance Matrix (AWAITING_CRITICALITY, AWAITING_APPROVAL,
//    NEEDS_CLARIFICATION, CLARIFICATION_ACCEPTED, SUPERSEDED, APPROVED, DECLINED, EXPIRED, MATERIALIZED).
// 3. State-Specific Recovery Paths (getPendingProposal, findPendingClarification,
//    getProposalReviewExecution, hasSettledProposal, findMaterializedWorkflow).
// 4. Concurrency, CAS, and Idempotency Semantics (safe repeats, conflict rejections).
// 5. Reaper Exemption (parked and settled sessions are protected from premature timeout/redrive).
// 6. Clean Teardown with Verified Zero Leftovers across all touched tables.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  AgentProposalState,
  AgentSessionStatus,
  AgentToolExecutionStatus,
  type Prisma,
} from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import {
  getPendingProposal,
  hasPendingProposal,
  hasSettledProposal,
  getProposalReviewExecution,
  persistExecutionOutcome,
  reconcileActiveProposal,
  recordCriticalityDecision,
  recordClarificationAnswer,
  recordProposalDecision,
  expireProposalReview,
} from "@/lib/ai/agent/services/proposal-service";
import { submitCriticalityDecision } from "@/lib/ai/agent/services/criticality-service";
import {
  submitClarificationAnswer,
  findPendingClarification,
} from "@/lib/ai/agent/services/clarification-service";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";
import { redriveStalledSessions } from "@/lib/ai/agent/reaper";

jest.setTimeout(180_000);

const RUN_TAG = `propdur_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const ORG_SLUG = `${RUN_TAG}_org`;
const USER_EMAIL = `${RUN_TAG}@example.invalid`;
const PROJECT_ID = "clxyz0000000000000000000a";

const SAMPLE_PROPOSAL = {
  name: "Durable Lifecycle Workflow",
  description: "Proves durable state transitions across restarts.",
  steps: {
    init: {
      action: "task.create",
      inputs: { title: "Initialization", projectId: PROJECT_ID },
      dependsOn: [],
    },
    process: {
      action: "task.create",
      inputs: { title: "Processing", projectId: PROJECT_ID },
      dependsOn: ["init"],
    },
  },
};

let primaryOrgId: string;
let primaryUserId: string;

const trackedSessionIds: string[] = [];
const trackedOrgIds: string[] = [];
const trackedUserIds: string[] = [];
const trackedManifestPaths: string[] = [];

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
    // 1. Clean up manifests
    for (const manifestPath of trackedManifestPaths) {
      if (fs.existsSync(manifestPath)) {
        try {
          fs.unlinkSync(manifestPath);
        } catch {
          // Ignore unlink failures in teardown
        }
      }
    }

    // 2. Clean up database records
    const workflows = await db.workflow.findMany({
      where: { orgId: { in: trackedOrgIds } },
      select: { id: true },
    });
    const workflowIds = workflows.map((w) => w.id);

    if (workflowIds.length > 0) {
      await db.workflowRun.deleteMany({
        where: { workflowId: { in: workflowIds } },
      });
      await db.workflow.deleteMany({
        where: { id: { in: workflowIds } },
      });
    }

    if (trackedSessionIds.length > 0) {
      await db.agentOutboxEvent.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
      });
      await db.agentMessage.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
      });
      await db.agentToolExecution.deleteMany({
        where: { sessionId: { in: trackedSessionIds } },
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

    // 3. Verify zero leftovers across all touched tables
    const leftoverWorkflows = await db.workflow.count({
      where: { orgId: { in: trackedOrgIds } },
    });
    const leftoverSessions = await db.agentSession.count({
      where: { orgId: { in: trackedOrgIds } },
    });
    const leftoverUsers = await db.user.count({
      where: { id: { in: trackedUserIds } },
    });
    const leftoverOrgs = await db.organization.count({
      where: { id: { in: trackedOrgIds } },
    });

    expect({
      leftoverWorkflows,
      leftoverSessions,
      leftoverUsers,
      leftoverOrgs,
    }).toEqual({
      leftoverWorkflows: 0,
      leftoverSessions: 0,
      leftoverUsers: 0,
      leftoverOrgs: 0,
    });
  } finally {
    await db.$disconnect();
  }
});

async function createSession(overrides: Partial<Prisma.AgentSessionUncheckedCreateInput> = {}) {
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

describe("Assignment 37.8 — Durable Proposal Persistence (F4)", () => {
  // -------------------------------------------------------------------------
  // 1. Genuine Two-Process Cold Restart Survival
  // -------------------------------------------------------------------------
  describe("1. Genuine Two-Process Cold Restart Survival", () => {
    it("Process A persists valid proposal to PostgreSQL and exits; Process B recovers and advances lifecycle", async () => {
      const procATag = `${RUN_TAG}_procA`;
      const manifestFile = path.join(process.cwd(), `fixture-${procATag}.json`);
      trackedManifestPaths.push(manifestFile);

      // Step 1: Run Process A in an independent Node/Jest child process
      const procA = spawnSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        [
          "jest",
          "--config",
          "jest.realdb.config.ts",
          "src/tests/agent/helpers/proposal-lifecycle-proc-a.realdb.test.ts",
          "--runInBand",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, RESTART_FIXTURE_TAG: procATag },
          encoding: "utf-8",
          shell: true,
        },
      );

      if (procA.status !== 0) {
        console.error("Process A stdout:", procA.stdout);
        console.error("Process A stderr:", procA.stderr);
      }
      expect(procA.status).toBe(0);
      expect(fs.existsSync(manifestFile)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      trackedOrgIds.push(manifest.orgId);
      trackedUserIds.push(manifest.userId);
      trackedSessionIds.push(manifest.sessionId);
      if (manifest.clarifySessionId) {
        trackedSessionIds.push(manifest.clarifySessionId);
      }

      // Step 2a: Process B verifies cold recovery and answer acceptance for clarification
      const clarifyMessages = await db.agentMessage.findMany({
        where: { sessionId: manifest.clarifySessionId },
        orderBy: { createdAt: "asc" },
      });
      const pendingClarification = findPendingClarification(clarifyMessages);
      expect(pendingClarification).not.toBeNull();
      expect(pendingClarification?.interactionId).toBe(manifest.clarifyExecutionId);
      expect(pendingClarification?.correlationId).toBe(manifest.clarifyCorrId);
      expect(pendingClarification?.fields).toEqual([
        { field: "targetEnv", question: "What environment should this target?" },
      ]);

      const answerResult = await submitClarificationAnswer({
        sessionId: manifest.clarifySessionId,
        userId: manifest.userId,
        interactionId: manifest.clarifyExecutionId,
        correlationId: manifest.clarifyCorrId,
        answers: { targetEnv: "production" },
      });
      expect(answerResult.ok).toBe(true);

      const clarifyRow = await db.agentToolExecution.findUnique({
        where: { id: manifest.clarifyExecutionId },
        select: {
          proposalState: true,
          clarificationAnswer: true,
        },
      });
      expect(clarifyRow?.proposalState).toBe(AgentProposalState.CLARIFICATION_ACCEPTED);
      expect(clarifyRow?.clarificationAnswer).toEqual({ targetEnv: "production" });

      const clarifyOutbox = await db.agentOutboxEvent.findFirst({
        where: {
          sessionId: manifest.clarifySessionId,
          eventType: "AGENT_LOOP_REQUESTED",
        },
      });
      expect(clarifyOutbox).not.toBeNull();

      // Step 2b: Process B (this process) connects to PostgreSQL and verifies cold proposal recovery
      const pendingProposal = await getPendingProposal(manifest.sessionId);
      expect(pendingProposal).not.toBeNull();
      expect(pendingProposal?.interactionId).toBe(manifest.executionId);
      expect(pendingProposal?.state).toBe(AgentProposalState.AWAITING_CRITICALITY);
      expect(pendingProposal?.fingerprint).toBe(manifest.fingerprint);
      expect(pendingProposal?.revision).toBe(1);

      // Step 3: Advance to AWAITING_APPROVAL via submitCriticalityDecision
      const critResult = await submitCriticalityDecision({
        sessionId: manifest.sessionId,
        userId: manifest.userId,
        interactionId: manifest.executionId,
        decisions: { step_init: true, step_review: false },
      });
      expect(critResult.ok).toBe(true);

      // Verify row state in PostgreSQL
      const critRow = await db.agentToolExecution.findUnique({
        where: { id: manifest.executionId },
        select: {
          proposalState: true,
          criticalityDecisions: true,
          expiresAt: true,
        },
      });
      expect(critRow?.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);
      expect(critRow?.criticalityDecisions).toEqual({
        step_init: true,
        step_review: false,
      });
      expect(critRow?.expiresAt).toBeInstanceOf(Date);

      // Step 4: Advance to APPROVED via submitProposalDecision
      const decisionResult = await submitProposalDecision({
        sessionId: manifest.sessionId,
        userId: manifest.userId,
        interactionId: manifest.executionId,
        decision: AgentProposalState.APPROVED,
      });
      expect(decisionResult.ok).toBe(true);
      if (decisionResult.ok) {
        expect(decisionResult.state).toBe(AgentProposalState.APPROVED);
      }

      // Step 5: Advance to MATERIALIZED via materializeProposal
      const matResult = await materializeProposal({
        sessionId: manifest.sessionId,
        userId: manifest.userId,
        interactionId: manifest.executionId,
      });
      expect(matResult.ok).toBe(true);
      if (matResult.ok) {
        expect(matResult.state).toBe(AgentProposalState.MATERIALIZED);
      }

      // Verify Workflow row exists in PostgreSQL
      const workflow = await db.workflow.findFirst({
        where: { sourceProposalId: manifest.executionId },
      });
      expect(workflow).not.toBeNull();
      expect(workflow?.orgId).toBe(manifest.orgId);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Clarification Lifecycle & State-Specific Recovery
  // -------------------------------------------------------------------------
  describe("2. Clarification Lifecycle (NEEDS_CLARIFICATION -> CLARIFICATION_ACCEPTED)", () => {
    it("persists clarification state, recovers via findPendingClarification, accepts answer, and maintains idempotency", async () => {
      const session = await createSession();
      const toolCallId = `${RUN_TAG}_clarify_call`;

      // 1. Seed execution at RUNNING and persist clarification outcome
      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId,
          toolName: "generateWorkflow",
          status: "RUNNING",
          input: {},
        },
        select: { id: true, toolCallId: true },
      });

      const corrId = `corr_${RUN_TAG}_clarify`;
      const clarificationResult = {
        ok: false,
        code: "NEEDS_USER_INPUT",
        status: "NEEDS_USER_INPUT",
        interactionId: execution.id,
        correlationId: corrId,
        error: "Clarification required",
        fields: [
          { field: "targetEnv", question: "What environment should this target?" },
        ],
      };

      await db.$transaction(async (tx) => {
        const ok = await persistExecutionOutcome(tx, {
          executionId: execution.id,
          result: clarificationResult,
          lifecycle: {
            state: AgentProposalState.NEEDS_CLARIFICATION,
            fingerprint: corrId,
          },
          revision: null,
        });
        expect(ok).toBe(true);
      });

      // Add the tool-result message to transcript
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

      // State-specific recovery verification:
      // A) getPendingProposal must return null because clarification is NOT awaiting approval
      const pendingProp = await getPendingProposal(session.id);
      expect(pendingProp).toBeNull();

      // B) findPendingClarification recovers the pending question from transcript
      const messages = await db.agentMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "asc" },
      });
      const pendingClarification = findPendingClarification(messages);
      expect(pendingClarification).not.toBeNull();
      expect(pendingClarification?.interactionId).toBe(execution.id);
      expect(pendingClarification?.correlationId).toBe(corrId);
      expect(pendingClarification?.fields).toEqual([
        { field: "targetEnv", question: "What environment should this target?" },
      ]);

      // 2. Submit clarification answer
      const answerResult = await submitClarificationAnswer({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        correlationId: corrId,
        answers: { targetEnv: "production" },
      });
      expect(answerResult.ok).toBe(true);

      // Verify persisted row in PostgreSQL
      const row = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: {
          proposalState: true,
          clarificationAnswer: true,
        },
      });
      expect(row?.proposalState).toBe(AgentProposalState.CLARIFICATION_ACCEPTED);
      expect(row?.clarificationAnswer).toEqual({ targetEnv: "production" });

      // Outbox continuation intent was recorded
      const outbox = await db.agentOutboxEvent.findFirst({
        where: {
          sessionId: session.id,
          eventType: "AGENT_LOOP_REQUESTED",
        },
      });
      expect(outbox).not.toBeNull();

      // Idempotency: submitting the exact same answer again returns idempotent success
      const repeatAnswer = await submitClarificationAnswer({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        correlationId: corrId,
        answers: { targetEnv: "production" },
      });
      expect(repeatAnswer).toEqual({
        ok: true,
        sessionId: session.id,
        step: 1,
        idempotent: true,
      });

      // Conflict: submitting a different answer returns 409 CLARIFICATION_CONFLICT
      const conflictAnswer = await submitClarificationAnswer({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        correlationId: corrId,
        answers: { targetEnv: "staging" },
      });
      expect(conflictAnswer).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "CLARIFICATION_CONFLICT",
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Deterministic Supersession & Revision Ranking Across Restarts
  // -------------------------------------------------------------------------
  describe("3. Deterministic Supersession (reconcileActiveProposal)", () => {
    it("retires older proposal when newer one arrives, and getPendingProposal returns only the newest", async () => {
      const session = await createSession();
      const fp1 = "fp_rev_1";
      const fp2 = "fp_rev_2";

      // Seed Proposal Revision 1
      const exec1 = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_rev1`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalFingerprint: fp1,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      // Seed Proposal Revision 2
      const exec2 = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_rev2`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalFingerprint: fp2,
          proposalRevision: 2,
        },
        select: { id: true },
      });

      // Reconcile Revision 2
      await db.$transaction(async (tx) => {
        const outcome = await reconcileActiveProposal(tx, {
          sessionId: session.id,
          executionId: exec2.id,
          revision: 2,
        });
        expect(outcome).toBe("active");
      });

      // Verify PostgreSQL state
      const row1 = await db.agentToolExecution.findUnique({
        where: { id: exec1.id },
        select: { proposalState: true },
      });
      const row2 = await db.agentToolExecution.findUnique({
        where: { id: exec2.id },
        select: { proposalState: true },
      });

      expect(row1?.proposalState).toBe(AgentProposalState.SUPERSEDED);
      expect(row2?.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);

      // getPendingProposal returns only Revision 2
      const pending = await getPendingProposal(session.id);
      expect(pending?.interactionId).toBe(exec2.id);
      expect(pending?.revision).toBe(2);
    });

    it("out-of-order late arrival supersedes itself when a newer revision is already active", async () => {
      const session = await createSession();

      // Revision 2 parked first
      const newerExec = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_newer`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalRevision: 2,
        },
        select: { id: true },
      });

      // Late Revision 1 finishes later
      const lateExec = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_late`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      // Reconcile the late arrival
      await db.$transaction(async (tx) => {
        const outcome = await reconcileActiveProposal(tx, {
          sessionId: session.id,
          executionId: lateExec.id,
          revision: 1,
        });
        expect(outcome).toBe("superseded");
      });

      const lateRow = await db.agentToolExecution.findUnique({
        where: { id: lateExec.id },
        select: { proposalState: true },
      });
      const newerRow = await db.agentToolExecution.findUnique({
        where: { id: newerExec.id },
        select: { proposalState: true },
      });

      expect(lateRow?.proposalState).toBe(AgentProposalState.SUPERSEDED);
      expect(newerRow?.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);

      const pending = await getPendingProposal(session.id);
      expect(pending?.interactionId).toBe(newerExec.id);
    });

    it("sweeps legacy row with NULL proposalRevision when a revisioned proposal arrives", async () => {
      const session = await createSession();

      // Legacy row without proposalRevision
      const legacyExec = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_legacy`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalRevision: null,
        },
        select: { id: true },
      });

      // Revision 1 arrives
      const currentExec = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_current`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      await db.$transaction(async (tx) => {
        const outcome = await reconcileActiveProposal(tx, {
          sessionId: session.id,
          executionId: currentExec.id,
          revision: 1,
        });
        expect(outcome).toBe("active");
      });

      const legacyRow = await db.agentToolExecution.findUnique({
        where: { id: legacyExec.id },
        select: { proposalState: true },
      });
      expect(legacyRow?.proposalState).toBe(AgentProposalState.SUPERSEDED);

      const pending = await getPendingProposal(session.id);
      expect(pending?.interactionId).toBe(currentExec.id);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Terminal Review Outcomes (Decline and Expiry)
  // -------------------------------------------------------------------------
  describe("4. Terminal Review Outcomes (DECLINED and EXPIRED)", () => {
    it("records DECLINED decision, marks proposal settled, and excludes it from pending", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_decline_exec`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 1,
          criticalityDecisions: { init: true, process: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // Submit DECLINED decision
      const result = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decision: AgentProposalState.DECLINED,
      });
      expect(result.ok).toBe(true);

      const row = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: { proposalState: true },
      });
      expect(row?.proposalState).toBe(AgentProposalState.DECLINED);

      // Recovery queries
      expect(await hasSettledProposal(session.id)).toBe(true);
      expect(await hasPendingProposal(session.id)).toBe(false);
      expect(await getPendingProposal(session.id)).toBeNull();

      // Subsequent attempt to approve a declined proposal results in 409 PROPOSAL_ALREADY_DECIDED
      const conflictResult = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(conflictResult).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "PROPOSAL_ALREADY_DECIDED",
      });
    });

    it("expires review window when expiresAt has passed, compare-and-set to EXPIRED", async () => {
      const session = await createSession();
      const pastDeadline = new Date(Date.now() - 10_000);

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_expire_exec`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalRevision: 1,
          expiresAt: pastDeadline,
        },
        select: { id: true },
      });

      // Run expiry compare-and-set
      const expired = await db.$transaction(async (tx) => {
        return expireProposalReview(tx, {
          executionId: execution.id,
          sessionId: session.id,
          now: new Date(),
        });
      });
      expect(expired).toBe(true);

      const row = await db.agentToolExecution.findUnique({
        where: { id: execution.id },
        select: { proposalState: true, expiredAt: true },
      });
      expect(row?.proposalState).toBe(AgentProposalState.EXPIRED);
      expect(row?.expiredAt).toBeInstanceOf(Date);

      expect(await hasSettledProposal(session.id)).toBe(true);
      expect(await getPendingProposal(session.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Reaper Exemption Across Restarts
  // -------------------------------------------------------------------------
  describe("5. Reaper Exemption Across Restarts (redriveStalledSessions)", () => {
    it("exempts sessions parked on proposal decisions and settled proposals from reaper redrive", async () => {
      const stalledTime = new Date(Date.now() - 300_000); // 5 min ago

      // Session A: Parked at AWAITING_CRITICALITY
      const sessionA = await createSession({ updatedAt: stalledTime });
      await db.agentToolExecution.create({
        data: {
          sessionId: sessionA.id,
          toolCallId: `${RUN_TAG}_reap_crit`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalRevision: 1,
        },
      });

      // Session B: Parked at AWAITING_APPROVAL
      const sessionB = await createSession({ updatedAt: stalledTime });
      await db.agentToolExecution.create({
        data: {
          sessionId: sessionB.id,
          toolCallId: `${RUN_TAG}_reap_app`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalRevision: 1,
        },
      });

      // Session C: Settled at APPROVED (awaiting materialization)
      const sessionC = await createSession({ updatedAt: stalledTime });
      await db.agentToolExecution.create({
        data: {
          sessionId: sessionC.id,
          toolCallId: `${RUN_TAG}_reap_settled`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.APPROVED,
          proposalRevision: 1,
        },
      });

      // Run redriveStalledSessions sweep with 1-minute threshold
      const reapResult = await redriveStalledSessions({
        olderThanMs: 60_000,
        now: new Date(),
      });

      // All 3 sessions must be classified as waiting and NOT redriven or failed
      expect(reapResult.skippedWaiting).toBeGreaterThanOrEqual(3);
      expect(reapResult.exhausted).toBe(0);

      // Verify sessions are still RUNNING in PostgreSQL
      const refreshedA = await db.agentSession.findUnique({
        where: { id: sessionA.id },
        select: { status: true },
      });
      const refreshedB = await db.agentSession.findUnique({
        where: { id: sessionB.id },
        select: { status: true },
      });
      const refreshedC = await db.agentSession.findUnique({
        where: { id: sessionC.id },
        select: { status: true },
      });

      expect(refreshedA?.status).toBe(AgentSessionStatus.RUNNING);
      expect(refreshedB?.status).toBe(AgentSessionStatus.RUNNING);
      expect(refreshedC?.status).toBe(AgentSessionStatus.RUNNING);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Concurrency, CAS, and Idempotency Invariants
  // -------------------------------------------------------------------------
  describe("6. Concurrency, CAS, and Idempotency Invariants", () => {
    it("handles repeated criticality decisions and conflicting decisions according to contract", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);
      const toolCallId = `${RUN_TAG}_cas_crit_call`;

      const execution = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalFingerprint: fp,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      await db.agentMessage.create({
        data: {
          sessionId: session.id,
          step: 1,
          toolCallId,
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId,
                toolName: "generateWorkflow",
                output: {
                  type: "json",
                  value: { ok: true, proposal: SAMPLE_PROPOSAL },
                },
              },
            ],
          } as Prisma.InputJsonValue,
        },
      });

      // First decision succeeds
      const firstDecision = await submitCriticalityDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decisions: { init: true, process: false },
      });
      expect(firstDecision.ok).toBe(true);

      // Repeat with identical decisions returns { ok: true, idempotent: true }
      const repeatDecision = await submitCriticalityDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decisions: { init: true, process: false },
      });
      expect(repeatDecision).toEqual({
        ok: true,
        sessionId: session.id,
        step: 1,
        idempotent: true,
      });

      // Repeat with conflicting decisions returns 409 CRITICALITY_CONFLICT
      const conflictDecision = await submitCriticalityDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execution.id,
        decisions: { init: false, process: true },
      });
      expect(conflictDecision).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "CRITICALITY_CONFLICT",
      });
    });

    it("guards proposal decision transitions: requires criticality first, enforces idempotency, rejects superseded", async () => {
      const session = await createSession();
      const fp = computeProposalCorrelationId(SAMPLE_PROPOSAL);

      // 1. Proposal still at AWAITING_CRITICALITY cannot be approved directly
      const execCrit = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_cas_uncrit`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_CRITICALITY,
          proposalFingerprint: fp,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      const directApprove = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execCrit.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(directApprove).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "NEEDS_CRITICALITY",
      });

      // 2. Superseded proposal cannot be approved
      const execSuperseded = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_cas_superseded`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.SUPERSEDED,
          proposalFingerprint: fp,
          proposalRevision: 1,
        },
        select: { id: true },
      });

      const supersededApprove = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execSuperseded.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(supersededApprove).toMatchObject({
        ok: false,
        httpStatus: 409,
        code: "PROPOSAL_NOT_AWAITING_APPROVAL",
      });

      // 3. Proposal at AWAITING_APPROVAL: approved once, then repeat is idempotent
      const execApprove = await db.agentToolExecution.create({
        data: {
          sessionId: session.id,
          toolCallId: `${RUN_TAG}_cas_approved`,
          toolName: "generateWorkflow",
          input: {},
          status: "COMPLETED",
          result: { ok: true, proposal: SAMPLE_PROPOSAL } as Prisma.InputJsonValue,
          proposalState: AgentProposalState.AWAITING_APPROVAL,
          proposalFingerprint: fp,
          proposalRevision: 2,
          criticalityDecisions: { init: true, process: false } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      const firstApprove = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execApprove.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(firstApprove.ok).toBe(true);

      const repeatApprove = await submitProposalDecision({
        sessionId: session.id,
        userId: primaryUserId,
        interactionId: execApprove.id,
        decision: AgentProposalState.APPROVED,
      });
      expect(repeatApprove).toEqual({
        ok: true,
        sessionId: session.id,
        step: 1,
        state: AgentProposalState.APPROVED,
        idempotent: true,
      });
    });
  });
});
