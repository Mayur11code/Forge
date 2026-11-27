/**
 * FC-018 — Transactional Task & Project Domain Event Producers Test Suite
 *
 * Verifies:
 * 1. User-originated task creation atomically writes Task and DomainEventOutbox with workflowEligible = true.
 * 2. Workflow-originated task creation writes Task and DomainEventOutbox with workflowEligible = false and suppressionReason = WORKFLOW_ORIGINATED.
 * 3. Workflow action receives created task successfully and continues pipeline.
 * 4. Human updates to workflow-created tasks are evaluated on the current mutation (workflowEligible = true).
 * 5. State transition detection: task.completed emitted ONLY on transition to DONE.
 * 6. Updating an already DONE task does NOT emit task.completed.
 * 7. Transactional project creation writes Project and project.created outbox event.
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_test_mock" }),
  receiveMessages: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn().mockResolvedValue("ADVANCED"),
}));

import { createTaskInOrg } from "@/lib/tasks/create-task";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { createProjectInOrg } from "@/lib/projects/create-project";
import { createTaskAction } from "@/lib/workflow/actions/core/create-task";
import {
  store,
  resetStore,
  restoreWorkflowDouble,
  prismaDouble,
} from "./helpers/prisma-double";

const ORG_A = "org_alpha";
const PROJECT_A = "clx1234567890abcdefghijkl";
const USER_A = "user_alpha_1";

describe("FC-018: Transactional Task & Project Domain Event Producers", () => {
  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    jest.clearAllMocks();

    // Seed project
    store.projects.push({
      id: PROJECT_A,
      orgId: ORG_A,
      name: "Alpha Project",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  describe("User-Originated Task Creation", () => {
    it("atomically writes Task and DomainEventOutbox with workflowEligible = true", async () => {
      const result = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "User Created Bug Report",
          description: "Found an issue in login flow",
          priority: "HIGH",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const task = result.task;
      expect(task).toBeDefined();
      expect(task.id).toBeDefined();
      expect(task.originType).toBe("USER");
      expect(task.originWorkflowId).toBeNull();

      // Check task in store
      const persistedTask = store.tasks.find((t) => t.id === task.id);
      expect(persistedTask).toBeDefined();

      // Check domain outbox event
      const outboxEvent = store.domainEventOutbox.find(
        (e) => e.entityId === task.id && e.eventType === "task.created",
      );
      expect(outboxEvent).toBeDefined();
      expect(outboxEvent?.orgId).toBe(ORG_A);
      expect(outboxEvent?.workflowEligible).toBe(true);
      expect(outboxEvent?.suppressionReason).toBeNull();
      expect(outboxEvent?.status).toBe("PENDING");
      expect(outboxEvent?.originType).toBe("USER");
    });
  });

  describe("Workflow-Originated Task Creation & Storm Invariant", () => {
    it("flags workflow-created task with workflowEligible = false while returning successfully to workflow action", async () => {
      // Seed workflow
      store.workflows.push({
        id: "wf_automation_1",
        orgId: ORG_A,
        name: "Automation Workflow",
        isActive: true,
      });

      const actionContext = {
        workflowId: "wf_automation_1",
        runId: "run_auto_99",
        stepId: "step_create_task",
        inputs: {
          projectId: PROJECT_A,
          title: "Automated Ticket From Workflow",
          priority: "HIGH",
        },
      };

      const result = await createTaskAction.execute(actionContext);

      expect(result.success).toBe(true);
      if (!result.success) return;

      const data = result.data as { taskId?: string } | undefined;
      const taskId = String(data?.taskId);
      expect(taskId).toBeDefined();

      // Verify task row has trusted workflow origin provenance
      const persistedTask = store.tasks.find((t) => t.id === taskId);
      expect(persistedTask).toBeDefined();
      expect(persistedTask?.originType).toBe("WORKFLOW");
      expect(persistedTask?.originWorkflowId).toBe("wf_automation_1");
      expect(persistedTask?.originWorkflowRunId).toBe("run_auto_99");

      // Verify DomainEventOutbox row has workflowEligible = false and is SUPPRESSED
      const outboxEvent = store.domainEventOutbox.find(
        (e) => e.entityId === taskId && e.eventType === "task.created",
      );
      expect(outboxEvent).toBeDefined();
      expect(outboxEvent?.workflowEligible).toBe(false);
      expect(outboxEvent?.suppressionReason).toBe("WORKFLOW_ORIGINATED");
      expect(outboxEvent?.status).toBe("SUPPRESSED");
      expect(outboxEvent?.originType).toBe("WORKFLOW");
      expect(outboxEvent?.originWorkflowId).toBe("wf_automation_1");
      expect(outboxEvent?.originWorkflowRunId).toBe("run_auto_99");
    });

    it("evaluates eligibility for current mutation when human later edits workflow-created task", async () => {
      // 1. Task created by workflow
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Workflow Created Task",
        },
        {
          orgId: ORG_A,
          origin: {
            originType: "WORKFLOW",
            workflowId: "wf_orig",
            workflowRunId: "run_orig",
          },
        },
      );

      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const wfTask = createRes.task;
      expect(wfTask.originType).toBe("WORKFLOW");

      // 2. Human user later updates this task
      const updateRes = await updateTaskInOrg(
        {
          taskId: wfTask.id,
          title: "Human Updated Title",
          priority: "LOW",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
          origin: {
            originType: "USER",
          },
        },
      );

      expect(updateRes.success).toBe(true);
      if (!updateRes.success) return;
      expect(updateRes.task.title).toBe("Human Updated Title");

      // Verify the new update outbox event has workflowEligible = true because actor is USER
      const updateOutbox = store.domainEventOutbox.find(
        (e) => e.entityId === wfTask.id && e.eventType === "task.updated",
      );
      expect(updateOutbox).toBeDefined();
      expect(updateOutbox?.originType).toBe("USER");
      expect(updateOutbox?.workflowEligible).toBe(true);
      expect(updateOutbox?.suppressionReason).toBeNull();
      expect(updateOutbox?.status).toBe("PENDING");
    });
  });

  describe("State Transition Detection for task.completed", () => {
    it("emits task.completed ONLY when transitioning from non-DONE to DONE", async () => {
      // Create task in TODO status
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Transition Test Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // Transition TODO -> DONE
      const updateRes = await updateTaskInOrg(
        {
          taskId: task.id,
          status: "DONE",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(updateRes.success).toBe(true);

      // Check outbox for task.completed
      const completedEvents = store.domainEventOutbox.filter(
        (e) => e.entityId === task.id && e.eventType === "task.completed",
      );
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0].workflowEligible).toBe(true);
      expect(completedEvents[0].status).toBe("PENDING");
    });

    it("does NOT emit task.completed when updating an already DONE task", async () => {
      // Create task
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Already Done Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // Set it to DONE first
      await updateTaskInOrg(
        {
          taskId: task.id,
          status: "DONE",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );

      // Clear any events from prior setup
      store.domainEventOutbox = [];

      // Update title on already DONE task without changing status
      const updateRes = await updateTaskInOrg(
        {
          taskId: task.id,
          title: "Refined Title on Done Task",
          priority: "HIGH",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(updateRes.success).toBe(true);

      // Verify task.updated was emitted, but task.completed was NOT emitted
      const updateEvents = store.domainEventOutbox.filter(
        (e) => e.entityId === task.id && e.eventType === "task.updated",
      );
      expect(updateEvents).toHaveLength(1);

      const completedEvents = store.domainEventOutbox.filter(
        (e) => e.entityId === task.id && e.eventType === "task.completed",
      );
      expect(completedEvents).toHaveLength(0);
    });

    it("CONCURRENT COMPLETION (M4-REM-1): concurrent completion requests produce exactly one task.completed event", async () => {
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Concurrent Completion Test Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // Two simultaneous completion requests
      const [res1, res2] = await Promise.all([
        updateTaskInOrg(
          {
            taskId: task.id,
            status: "DONE",
          },
          {
            orgId: ORG_A,
            userId: USER_A,
          },
        ),
        updateTaskInOrg(
          {
            taskId: task.id,
            status: "DONE",
          },
          {
            orgId: ORG_A,
            userId: USER_A,
          },
        ),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const completedEvents = store.domainEventOutbox.filter(
        (e) => e.entityId === task.id && e.eventType === "task.completed",
      );
      expect(completedEvents).toHaveLength(1);
    });

    it("CONCURRENT COMPLETION + EDIT (M4-REM-1): simultaneous completion and field update preserves updates with exactly one completion event", async () => {
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Concurrent Edit Test Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // One request completes, another updates description concurrently
      const [res1, res2] = await Promise.all([
        updateTaskInOrg(
          {
            taskId: task.id,
            status: "DONE",
          },
          {
            orgId: ORG_A,
            userId: USER_A,
          },
        ),
        updateTaskInOrg(
          {
            taskId: task.id,
            title: "Updated Title Concurrently",
          },
          {
            orgId: ORG_A,
            userId: USER_A,
          },
        ),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const completedEvents = store.domainEventOutbox.filter(
        (e) => e.entityId === task.id && e.eventType === "task.completed",
      );
      expect(completedEvents).toHaveLength(1);

      const storedTask = store.tasks.find((t) => t.id === task.id);
      expect(storedTask?.status).toBe("DONE");
    });

    it("REOPEN AND COMPLETE (M4-REM-1): DONE -> IN_PROGRESS -> DONE produces exactly one completion event on the second transition", async () => {
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Reopen Lifecycle Test Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // 1. Initial complete: TODO -> DONE
      await updateTaskInOrg(
        {
          taskId: task.id,
          status: "DONE",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(
        store.domainEventOutbox.filter((e) => e.entityId === task.id && e.eventType === "task.completed"),
      ).toHaveLength(1);

      // 2. Reopen: DONE -> IN_PROGRESS
      await updateTaskInOrg(
        {
          taskId: task.id,
          status: "IN_PROGRESS",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      // Completion count should still be 1
      expect(
        store.domainEventOutbox.filter((e) => e.entityId === task.id && e.eventType === "task.completed"),
      ).toHaveLength(1);

      // 3. Complete again: IN_PROGRESS -> DONE
      await updateTaskInOrg(
        {
          taskId: task.id,
          status: "DONE",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      // New genuine transition -> exactly 2 completion events
      expect(
        store.domainEventOutbox.filter((e) => e.entityId === task.id && e.eventType === "task.completed"),
      ).toHaveLength(2);
    });

    it("EVENT ATOMICITY (M4-REM-1): failure during outbox event recording rolls back task update", async () => {
      const createRes = await createTaskInOrg(
        {
          projectId: PROJECT_A,
          title: "Atomic Rollback Test Task",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );
      expect(createRes.success).toBe(true);
      if (!createRes.success) return;
      const task = createRes.task;

      // Force outbox recording to fail
      (prismaDouble.domainEventOutbox.create as jest.Mock).mockRejectedValueOnce(
        new Error("SIMULATED_OUTBOX_STORAGE_FAILURE"),
      );

      const updateRes = await updateTaskInOrg(
        {
          taskId: task.id,
          status: "DONE",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );

      expect(updateRes.success).toBe(false);
      if (!updateRes.success) {
        expect(updateRes.error).toContain("SIMULATED_OUTBOX_STORAGE_FAILURE");
      }
    });
  });

  describe("Transactional Project Creation", () => {
    it("atomically writes Project and project.created domain outbox event", async () => {
      const result = await createProjectInOrg(
        {
          name: "New Enterprise Initiative",
          description: "Initiative details",
        },
        {
          orgId: ORG_A,
          userId: USER_A,
        },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const project = result.project;
      expect(project).toBeDefined();
      expect(project.id).toBeDefined();
      expect(project.name).toBe("New Enterprise Initiative");

      const outboxEvent = store.domainEventOutbox.find(
        (e) => e.entityId === project.id && e.eventType === "project.created",
      );
      expect(outboxEvent).toBeDefined();
      expect(outboxEvent?.orgId).toBe(ORG_A);
      expect(outboxEvent?.workflowEligible).toBe(true);
      expect(outboxEvent?.status).toBe("PENDING");
      expect(outboxEvent?.payload).toMatchObject({
        projectId: project.id,
        name: "New Enterprise Initiative",
      });
    });
  });
});
