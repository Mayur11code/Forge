// src/tests/workflow/m4-owner-acceptance.realdb.test.ts
//
// Level E3 Real PostgreSQL M4 Owner Acceptance Test Suite
// Executes all 6 sections (25+ tests) from the authoritative M4 Owner Acceptance Checklist
// against the live Neon PostgreSQL database.

jest.mock("server-only", () => ({}));

import { db } from "@/lib/prisma/db";
import { createTaskInOrg } from "@/lib/tasks/create-task";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { createProjectInOrg } from "@/lib/projects/create-project";
import { evaluateTriggerFilter, type TriggerFilterConfig } from "@/lib/workflow-types/trigger-filter";
import { simulateWorkflowRun } from "@/lib/workflow/execution/simulator";
import type { WorkflowDefinition } from "@/lib/workflow-types/workflow";
import { GET as cronHandler } from "@/app/api/cron/domain-outbox/route";
import { NextRequest } from "next/server";

jest.setTimeout(120_000);

const TAG = `m4_acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const ORG_A_ID = `${TAG}_org_a`;
const ORG_B_ID = `${TAG}_org_b`;
const USER_A_ID = `${TAG}_usr_a`;

describe("M4 — Owner Acceptance Checklist (Real PostgreSQL E3 Execution)", () => {
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    // 0. Setup isolated test organizations, user, and projects in Neon PostgreSQL
    await db.user.create({
      data: {
        id: USER_A_ID,
        email: `${TAG}@forge.test`,
        name: "M4 Owner Acceptance User",
      },
    });

    await db.organization.create({
      data: {
        id: ORG_A_ID,
        name: "M4 Acceptance Org Alpha",
        slug: `${TAG}-alpha`,
        memberships: {
          create: {
            userId: USER_A_ID,
            role: "ADMIN",
          },
        },
      },
    });

    await db.organization.create({
      data: {
        id: ORG_B_ID,
        name: "M4 Acceptance Org Beta",
        slug: `${TAG}-beta`,
      },
    });

    const projectA = await db.project.create({
      data: {
        orgId: ORG_A_ID,
        name: "Alpha Workstream",
      },
    });
    projectAId = projectA.id;

    const projectB = await db.project.create({
      data: {
        orgId: ORG_B_ID,
        name: "Beta Workstream",
      },
    });
    projectBId = projectB.id;
  });

  afterAll(async () => {
    try {
      await db.task.deleteMany({ where: { project: { orgId: { in: [ORG_A_ID, ORG_B_ID] } } } });
      await db.domainEventOutbox.deleteMany({ where: { orgId: { in: [ORG_A_ID, ORG_B_ID] } } });
      await db.project.deleteMany({ where: { orgId: { in: [ORG_A_ID, ORG_B_ID] } } });
      await db.membership.deleteMany({ where: { orgId: { in: [ORG_A_ID, ORG_B_ID] } } });
      await db.organization.deleteMany({ where: { id: { in: [ORG_A_ID, ORG_B_ID] } } });
      await db.user.deleteMany({ where: { id: USER_A_ID } });
    } catch {
      // ignore cleanup errors
    }
  });

  // ==========================================================================
  // SECTION 1: BASIC DOMAIN EVENT TRIGGERS
  // ==========================================================================
  describe("1. Basic Domain Event Triggers", () => {
    let testTaskId: string;

    test("1.1 Task creation — task.created: creates task and emits outbox event in PostgreSQL", async () => {
      const res = await createTaskInOrg(
        { projectId: projectAId, title: "Urgent Server Migration", priority: "HIGH" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(res.success).toBe(true);
      if (!res.success) return;
      testTaskId = res.task.id;

      const event = await db.domainEventOutbox.findFirst({
        where: { orgId: ORG_A_ID, eventType: "task.created", entityId: testTaskId },
      });

      expect(event).not.toBeNull();
      expect(event?.workflowEligible).toBe(true);
      expect(event?.originType).toBe("USER");
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.title).toBe("Urgent Server Migration");
      expect(payload.priority).toBe("HIGH");
    });

    test("1.2 Task updates — task.updated: emits distinct events with updated values", async () => {
      // First update: title
      const u1 = await updateTaskInOrg(
        { taskId: testTaskId, title: "Urgent Server Migration (Phase 2)" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(u1.success).toBe(true);

      // Second update: priority
      const u2 = await updateTaskInOrg(
        { taskId: testTaskId, priority: "LOW" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(u2.success).toBe(true);

      const events = await db.domainEventOutbox.findMany({
        where: { orgId: ORG_A_ID, eventType: "task.updated", entityId: testTaskId },
        orderBy: { createdAt: "asc" },
      });

      expect(events.length).toBeGreaterThanOrEqual(2);
      const latestPayload = events[events.length - 1].payload as Record<string, unknown>;
      expect(latestPayload.priority).toBe("LOW");
      expect(latestPayload.title).toBe("Urgent Server Migration (Phase 2)");
    });

    test("1.3 Task completion — task.completed: emits exactly once on completion, not on edit", async () => {
      // 1. Move to DONE
      const c1 = await updateTaskInOrg(
        { taskId: testTaskId, status: "DONE" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(c1.success).toBe(true);

      const completionEvents1 = await db.domainEventOutbox.findMany({
        where: { orgId: ORG_A_ID, eventType: "task.completed", entityId: testTaskId },
      });
      expect(completionEvents1.length).toBe(1);

      // 2. Edit title while status remains DONE -> MUST NOT produce another completion event
      const editDone = await updateTaskInOrg(
        { taskId: testTaskId, title: "Urgent Server Migration (Finalized)" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(editDone.success).toBe(true);

      const completionEvents2 = await db.domainEventOutbox.findMany({
        where: { orgId: ORG_A_ID, eventType: "task.completed", entityId: testTaskId },
      });
      expect(completionEvents2.length).toBe(1); // Still exactly 1!

      // 3. Reopen task (IN_PROGRESS) and complete again (DONE) -> produces ONE new completion event
      await updateTaskInOrg(
        { taskId: testTaskId, status: "IN_PROGRESS" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      await updateTaskInOrg(
        { taskId: testTaskId, status: "DONE" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );

      const completionEvents3 = await db.domainEventOutbox.findMany({
        where: { orgId: ORG_A_ID, eventType: "task.completed", entityId: testTaskId },
      });
      expect(completionEvents3.length).toBe(2); // Exactly 1 new event on re-completion
    });

    test("1.4 Project creation — project.created: commits project and outbox atomically", async () => {
      const res = await createProjectInOrg(
        { name: "Orbital Deployment" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(res.success).toBe(true);
      if (!res.success) return;

      const event = await db.domainEventOutbox.findFirst({
        where: { orgId: ORG_A_ID, eventType: "project.created", entityId: res.project.id },
      });

      expect(event).not.toBeNull();
      expect(event?.orgId).toBe(ORG_A_ID);
      const p = event?.payload as Record<string, unknown>;
      expect(p.name).toBe("Orbital Deployment");
    });
  });

  // ==========================================================================
  // SECTION 2: TRIGGER FILTERS
  // ==========================================================================
  describe("2. Trigger Filters", () => {
    test("2.1 / 2.2 priority equals HIGH vs LOW", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "priority", operator: "equals", value: "HIGH" }],
      };
      expect(evaluateTriggerFilter(config, { priority: "HIGH" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "LOW" })).toBe(false);
    });

    test("2.3 not_equals operator", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "status", operator: "not_equals", value: "DONE" }],
      };
      expect(evaluateTriggerFilter(config, { status: "TODO" })).toBe(true);
      expect(evaluateTriggerFilter(config, { status: "DONE" })).toBe(false);
    });

    test("2.4 in operator with multiple allowed values", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "priority", operator: "in", value: ["MEDIUM", "HIGH"] }],
      };
      expect(evaluateTriggerFilter(config, { priority: "HIGH" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "MEDIUM" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "LOW" })).toBe(false);
    });

    test("2.5 contains operator with string substring", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "title", operator: "contains", value: "Emergency" }],
      };
      expect(evaluateTriggerFilter(config, { title: "Emergency Database Failover" })).toBe(true);
      expect(evaluateTriggerFilter(config, { title: "Routine Weekly Sync" })).toBe(false);
    });

    test("2.6 compound AND condition", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [
          { field: "priority", operator: "equals", value: "HIGH" },
          { field: "status", operator: "equals", value: "TODO" },
        ],
      };
      expect(evaluateTriggerFilter(config, { priority: "HIGH", status: "TODO" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "HIGH", status: "DONE" })).toBe(false);
    });

    test("2.7 compound OR condition", () => {
      const config: TriggerFilterConfig = {
        logic: "OR",
        rules: [
          { field: "priority", operator: "equals", value: "HIGH" },
          { field: "priority", operator: "equals", value: "MEDIUM" },
        ],
      };
      expect(evaluateTriggerFilter(config, { priority: "HIGH" })).toBe(true);
      expect(evaluateTriggerFilter(config, { priority: "LOW" })).toBe(false);
    });

    test("2.8 missing field fails closed safely", () => {
      const config: TriggerFilterConfig = {
        logic: "AND",
        rules: [{ field: "nonExistentField", operator: "equals", value: "some_value" }],
      };
      expect(evaluateTriggerFilter(config, { priority: "HIGH" })).toBe(false);
    });
  });

  // ==========================================================================
  // SECTION 3: WORKFLOW-CREATED TASKS & STORM SUPPRESSION (CENTRAL INVARIANT)
  // ==========================================================================
  describe("3. Workflow-Created Tasks & Storm Protection", () => {
    let automatedTaskId: string;

    test("3.1 Human task has workflowEligible = true", async () => {
      const res = await createTaskInOrg(
        { projectId: projectAId, title: "Human Root Task" },
        { orgId: ORG_A_ID, userId: USER_A_ID, origin: { originType: "USER" } }
      );
      expect(res.success).toBe(true);
      if (!res.success) return;

      const event = await db.domainEventOutbox.findFirst({
        where: { entityId: res.task.id },
      });
      expect(event?.workflowEligible).toBe(true);
      expect(event?.originType).toBe("USER");
    });

    test("3.2 / 3.3 Workflow-created task creates task but suppresses outbox dispatch", async () => {
      const res = await createTaskInOrg(
        { projectId: projectAId, title: "Automated Workflow Task" },
        {
          orgId: ORG_A_ID,
          origin: {
            originType: "WORKFLOW",
            workflowId: "wf_parent_1",
            workflowVersionId: "wfv_parent_1",
            workflowRunId: "run_parent_1",
          },
        }
      );
      expect(res.success).toBe(true);
      if (!res.success) return;
      automatedTaskId = res.task.id;

      // Verify task exists in DB
      const taskInDb = await db.task.findUnique({ where: { id: automatedTaskId } });
      expect(taskInDb).not.toBeNull();
      expect(taskInDb?.originType).toBe("WORKFLOW");

      // Verify outbox record is suppressed (preventing infinite recursion)
      const event = await db.domainEventOutbox.findFirst({
        where: { entityId: automatedTaskId },
      });
      expect(event?.workflowEligible).toBe(false);
      expect(event?.originType).toBe("WORKFLOW");
      expect(event?.suppressionReason).toBe("WORKFLOW_ORIGINATED");
      expect(event?.status).toBe("SUPPRESSED");
    });

    test("3.4 Human edit on workflow-created task restores workflow eligibility", async () => {
      const res = await updateTaskInOrg(
        { taskId: automatedTaskId, title: "Human Manual Override of Subtask" },
        { orgId: ORG_A_ID, userId: USER_A_ID, origin: { originType: "USER" } }
      );
      expect(res.success).toBe(true);

      const event = await db.domainEventOutbox.findFirst({
        where: { entityId: automatedTaskId, eventType: "task.updated" },
        orderBy: { createdAt: "desc" },
      });

      expect(event?.workflowEligible).toBe(true);
      expect(event?.originType).toBe("USER");
    });
  });

  // ==========================================================================
  // SECTION 4: PUBLISHING, ISOLATION & EXECUTION
  // ==========================================================================
  describe("4. Publishing, Isolation and Execution", () => {
    test("4.1 Multi-tenant isolation: Org A mutations never leak to Org B", async () => {
      const resB = await createTaskInOrg(
        { projectId: projectBId, title: "Org B Private Task" },
        { orgId: ORG_B_ID, userId: USER_A_ID }
      );
      expect(resB.success).toBe(true);
      if (!resB.success) return;

      const eventB = await db.domainEventOutbox.findFirst({
        where: { entityId: resB.task.id },
      });
      expect(eventB?.orgId).toBe(ORG_B_ID);

      // Verify query scoped by Org A returns 0 records for Org B's task
      const orgAEvents = await db.domainEventOutbox.findMany({
        where: { orgId: ORG_A_ID, entityId: resB.task.id },
      });
      expect(orgAEvents.length).toBe(0);
    });

    test("4.2 Safe workflow simulation: zero database writes", async () => {
      const def: WorkflowDefinition = {
        id: "sim_def_1",
        name: "Sim Flow",
        steps: {
          trig_1: {
            id: "trig_1",
            kind: "TRIGGER",
            action: "task.created",
            dependsOn: [],
            isCritical: false,
            config: {},
          },
          act_1: {
            id: "act_1",
            kind: "ACTION",
            action: "task.create",
            dependsOn: ["trig_1"],
            isCritical: false,
            config: {
              projectId: projectAId,
              title: "Ghost Task {{trigger.outputs.title}}",
            },
          },
        },
      };

      const tasksBefore = await db.task.count({ where: { project: { orgId: ORG_A_ID } } });
      const runsBefore = await db.workflowRun.count();
      const outboxBefore = await db.domainEventOutbox.count({ where: { orgId: ORG_A_ID } });

      const simResult = await simulateWorkflowRun(def, { title: "Simulation Trigger" });

      const tasksAfter = await db.task.count({ where: { project: { orgId: ORG_A_ID } } });
      const runsAfter = await db.workflowRun.count();
      const outboxAfter = await db.domainEventOutbox.count({ where: { orgId: ORG_A_ID } });

      expect(simResult.status).toBe("COMPLETED");
      expect(tasksAfter).toBe(tasksBefore);
      expect(runsAfter).toBe(runsBefore);
      expect(outboxAfter).toBe(outboxBefore);
    });
  });

  // ==========================================================================
  // SECTION 5: WORKER RECOVERY & OPERATIONAL CHECKS
  // ==========================================================================
  describe("5. Worker Recovery and Operational Checks", () => {
    const savedSecret = process.env.CRON_SECRET;

    beforeAll(() => {
      process.env.CRON_SECRET = "test_owner_acceptance_secret_1234567890";
    });

    afterAll(() => {
      process.env.CRON_SECRET = savedSecret;
    });

    test("5.1 Rejects unauthenticated request with 401", async () => {
      const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", { method: "GET" });
      const res = await cronHandler(req);
      expect(res.status).toBe(401);
    });

    test("5.2 Rejects invalid CRON_SECRET with 401", async () => {
      const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", {
        method: "GET",
        headers: { Authorization: "Bearer wrong_secret" },
      });
      const res = await cronHandler(req);
      expect(res.status).toBe(401);
    });

    test("5.3 Accepts valid secret & reports telemetry", async () => {
      const req = new NextRequest("http://localhost:3000/api/cron/domain-outbox", {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const res = await cronHandler(req);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; processed: number; telemetry: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(typeof body.processed).toBe("number");
      expect(typeof body.telemetry?.pendingEligibleCount).toBe("number");
      expect(
        body.telemetry?.oldestPendingAgeSec === null ||
        typeof body.telemetry?.oldestPendingAgeSec === "number"
      ).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION 6: REAL POSTGRESQL CONCURRENCY & TRANSACTIONAL INVARIANTS (E3)
  // ==========================================================================
  describe("6. Real PostgreSQL Concurrency Invariants (E3)", () => {
    test("6.1 Concurrent Task Completion (M4-REM-1): simultaneous requests emit exactly 1 event", async () => {
      const taskRes = await createTaskInOrg(
        { projectId: projectAId, title: "Concurrent Completion Test Task", priority: "MEDIUM" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(taskRes.success).toBe(true);
      if (!taskRes.success) return;
      const concTaskId = taskRes.task.id;

      // Simultaneously trigger 2 concurrent completions against real Neon PostgreSQL
      const [r1, r2] = await Promise.all([
        updateTaskInOrg({ taskId: concTaskId, status: "DONE" }, { orgId: ORG_A_ID, userId: USER_A_ID }),
        updateTaskInOrg({ taskId: concTaskId, status: "DONE" }, { orgId: ORG_A_ID, userId: USER_A_ID }),
      ]);

      expect(r1.success || r2.success).toBe(true);

      const completionEvents = await db.domainEventOutbox.findMany({
        where: { entityId: concTaskId, eventType: "task.completed" },
      });

      // EXACTLY ONE completion event in PostgreSQL
      expect(completionEvents.length).toBe(1);
    });

    test("6.2 Transactional atomicity: failed task creation rolls back all outbox rows", async () => {
      const countBefore = await db.domainEventOutbox.count({ where: { orgId: ORG_A_ID } });

      const failRes = await createTaskInOrg(
        { projectId: "non_existent_project_id", title: "Failing Task" },
        { orgId: ORG_A_ID, userId: USER_A_ID }
      );
      expect(failRes.success).toBe(false);

      const countAfter = await db.domainEventOutbox.count({ where: { orgId: ORG_A_ID } });
      expect(countAfter).toBe(countBefore);
    });
  });
});
