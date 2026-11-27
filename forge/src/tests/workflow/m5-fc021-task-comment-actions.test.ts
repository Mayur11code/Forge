// src/tests/workflow/m5-fc021-task-comment-actions.test.ts
//
// M5 FC-021: Task Update and Comment Creation with Saga Compensation Test Suite.
// Verifies:
// 1. Worker-safe canonical comment service (`createCommentInOrg`, `appendTombstoneCommentInOrg`).
// 2. `task.update@1.0.0` forward execution, previousState snapshot, and compensation restore.
// 3. `task.update@1.0.0` concurrency protection (refuses to clobber human edits).
// 4. `comment.create@1.0.0` forward execution and idempotent rollback tombstone append.

jest.mock("server-only", () => ({}));

const mockTaskStore = new Map<string, {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  assigneeId: string | null;
  projectId: string;
}>();

const mockCommentStore = new Map<string, {
  id: string;
  content: string;
  taskId: string;
  userId: string;
  createdAt: Date;
}>();

const mockAuditLogs: Array<{ eventType: string; message: string; payload: unknown }> = [];

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        if (where.id === "wf_1") return Promise.resolve({ id: "wf_1", orgId: "org_1", name: "Main Workflow" });
        return Promise.resolve(null);
      }),
    },
    task: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string; project?: { orgId: string } } }) => {
        const task = mockTaskStore.get(where.id);
        if (!task) return Promise.resolve(null);
        if (where.project?.orgId && where.project.orgId !== "org_1") return Promise.resolve(null);
        return Promise.resolve({ ...task, project: { orgId: "org_1" } });
      }),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = mockTaskStore.get(where.id);
        if (!existing) throw new Error("Task not found");
        const updated = { ...existing, ...data };
        mockTaskStore.set(where.id, updated as typeof existing);
        return Promise.resolve(updated);
      }),
    },
    comment: {
      create: jest.fn().mockImplementation(({ data }: { data: { content: string; taskId: string; userId: string } }) => {
        const id = `comment_${mockCommentStore.size + 1}`;
        const newComment = { id, ...data, createdAt: new Date() };
        mockCommentStore.set(id, newComment);
        return Promise.resolve(newComment);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const comment = mockCommentStore.get(where.id);
        return Promise.resolve(comment ? { ...comment } : null);
      }),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: { content: string } }) => {
        const comment = mockCommentStore.get(where.id);
        if (!comment) throw new Error("Comment not found");
        const updated = { ...comment, ...data };
        mockCommentStore.set(where.id, updated);
        return Promise.resolve(updated);
      }),
      delete: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        mockCommentStore.delete(where.id);
        return Promise.resolve({ id: where.id });
      }),
    },
    membership: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { orgId: string; userId?: string } }) => {
        if (where.userId === "user_alice" || where.userId === "user_bob") {
          return Promise.resolve({ userId: where.userId, role: "MEMBER" });
        }
        if (!where.userId && where.orgId === "org_1") {
          return Promise.resolve({ userId: "user_alice", role: "ADMIN" });
        }
        return Promise.resolve(null);
      }),
    },
    executionAuditLog: {
      create: jest.fn().mockImplementation(({ data }: { data: { eventType: string; message: string; payload: unknown; runId?: string; stepId?: string } }) => {
        mockAuditLogs.push(data);
        return Promise.resolve(data);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: { where: { runId?: string; stepId?: string; eventType?: string } }) => {
        const found = mockAuditLogs.find((l) => {
          const item = l as { runId?: string; stepId?: string; eventType?: string };
          return (
            (!where.runId || item.runId === where.runId) &&
            (!where.stepId || item.stepId === where.stepId) &&
            (!where.eventType || item.eventType === where.eventType)
          );
        });
        return Promise.resolve(found || null);
      }),
    },
  },
}));

// Mock updateTaskInOrg to delegate to mock DB
jest.mock("@/lib/tasks/update-task", () => ({
  updateTaskInOrg: jest.fn().mockImplementation(async (changes: Record<string, unknown>, actor: { orgId: string; expectedState?: Record<string, unknown> }) => {
    const { taskId, ...data } = changes as { taskId: string; [key: string]: unknown };
    const task = mockTaskStore.get(taskId);
    if (!task) return { success: false, code: "TASK_NOT_FOUND", error: "Task not found" };

    if (actor?.expectedState && typeof actor.expectedState === "object") {
      for (const [field, expectedVal] of Object.entries(actor.expectedState)) {
        if (expectedVal !== undefined) {
          const currentVal = (task as Record<string, unknown>)[field] ?? null;
          const expVal = expectedVal ?? null;
          if (currentVal !== expVal) {
            return {
              success: false,
              code: "UPDATE_FAILED",
              error: `CONCURRENCY_CONFLICT: Field '${field}' has diverged (expected '${expVal}', found '${currentVal}')`,
            };
          }
        }
      }
    }

    const updated = { ...task, ...data };
    mockTaskStore.set(taskId, updated as typeof task);
    return { success: true, task: updated };
  }),
}));

import { updateTaskAction } from "@/lib/workflow/actions/core/update-task";
import { createCommentAction } from "@/lib/workflow/actions/core/create-comment";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { ActionRegistry, getAction } from "@/lib/workflow-types/action-registry";
import type { JsonValue } from "@/lib/workflow-types/type";

describe("M5 FC-021: task.update & comment.create Actions with Saga Compensation", () => {
  beforeEach(() => {
    mockTaskStore.clear();
    mockCommentStore.clear();
    mockAuditLogs.length = 0;
    jest.clearAllMocks();

    mockTaskStore.set("task_1", {
      id: "task_1",
      title: "Initial Task Title",
      status: "TODO",
      priority: "MEDIUM",
      description: "Initial description",
      assigneeId: null,
      projectId: "proj_1",
    });
  });

  describe("Action Registration & Contracts", () => {
    it("registers task.update and comment.create @1.0.0 in ActionRegistry", () => {
      expect(ActionRegistry["task.update"]).toBe(updateTaskAction);
      expect(ActionRegistry["comment.create"]).toBe(createCommentAction);
      expect(getAction("task.update", "1.0.0")).toBe(updateTaskAction);
      expect(getAction("comment.create", "1.0.0")).toBe(createCommentAction);
    });
  });

  describe("task.update@1.0.0", () => {
    it("executes forward update, captures previousState snapshot, and persists changes", async () => {
      const res = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
          priority: "HIGH",
          assigneeId: "user_alice",
        },
      });

      expect(res.success).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.taskId).toBe("task_1");
      expect(data.status).toBe("IN_PROGRESS");
      expect(data.priority).toBe("HIGH");

      // Verify previousState snapshot captured the original state
      const prev = data.previousState as Record<string, unknown>;
      expect(prev.status).toBe("TODO");
      expect(prev.priority).toBe("MEDIUM");
      expect(prev.assigneeId).toBeNull();

      // Verify task in DB was updated
      const updated = mockTaskStore.get("task_1");
      expect(updated?.status).toBe("IN_PROGRESS");
      expect(updated?.priority).toBe("HIGH");
      expect(updated?.assigneeId).toBe("user_alice");
    });

    it("compensates by restoring prior state on saga rollback", async () => {
      // First execute forward
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
          priority: "HIGH",
        },
      });
      expect(forwardRes.success).toBe(true);

      // Now execute compensation
      expect(updateTaskAction.compensate).toBeDefined();
      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(true);

      // Task status and priority must be reverted back to TODO and MEDIUM
      const restored = mockTaskStore.get("task_1");
      expect(restored?.status).toBe("TODO");
      expect(restored?.priority).toBe("MEDIUM");

      // Verify audit log receipt was committed
      expect(mockAuditLogs.some((l) => l.eventType === "COMPENSATION_TASK_UPDATED")).toBe(true);
    });

    // =======================================================================
    // ADVERSARIAL CONCURRENCY TESTS (M5-REM-1 / Phases 1 & 5)
    // =======================================================================

    // A. Workflow changes status and priority. Human changes priority. Downstream fails.
    // Compensation refuses to restore anything.
    it("Adversarial A: refuses compensation if human modified priority after workflow updated status and priority", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
          priority: "HIGH",
        },
      });
      expect(forwardRes.success).toBe(true);

      // Human operator changes priority to URGENT while status remains IN_PROGRESS
      const current = mockTaskStore.get("task_1")!;
      mockTaskStore.set("task_1", { ...current, priority: "URGENT" });

      // Saga rollback triggered
      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(false);
      expect(compRes.error).toContain("priority diverged");
      expect(compRes.error?.toLowerCase()).toContain("refusing to clobber human intent");

      // Verify human intent preserved: priority is still URGENT, status is still IN_PROGRESS
      const finalTask = mockTaskStore.get("task_1");
      expect(finalTask?.priority).toBe("URGENT");
      expect(finalTask?.status).toBe("IN_PROGRESS");

      // Verify conflict audit log committed
      expect(mockAuditLogs.some((l) => l.eventType === "COMPENSATION_CONFLICT_DETECTED")).toBe(true);
    });

    // B. Workflow changes title and description. Human edits description.
    // Compensation refuses to overwrite the human edit.
    it("Adversarial B: refuses compensation if human edited description after workflow changed title and description", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          title: "Automated New Title",
          description: "Automated New Description",
        },
      });
      expect(forwardRes.success).toBe(true);

      // Human edits description
      const current = mockTaskStore.get("task_1")!;
      mockTaskStore.set("task_1", { ...current, description: "Human Manual Notes Added" });

      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(false);
      expect(compRes.error).toContain("description diverged");

      // Description remains human manual notes, title remains automated title (no partial rollback)
      const finalTask = mockTaskStore.get("task_1");
      expect(finalTask?.description).toBe("Human Manual Notes Added");
      expect(finalTask?.title).toBe("Automated New Title");
    });

    // C. Workflow changes assigneeId. Human changes assigneeId.
    // Compensation refuses to overwrite it.
    it("Adversarial C: refuses compensation if human modified assigneeId after workflow reassigned it", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          assigneeId: "user_bot",
        },
      });
      expect(forwardRes.success).toBe(true);

      // Human reassigns to user_lead
      const current = mockTaskStore.get("task_1")!;
      mockTaskStore.set("task_1", { ...current, assigneeId: "user_lead" });

      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(false);
      expect(compRes.error).toContain("assigneeId diverged");
      expect(mockTaskStore.get("task_1")?.assigneeId).toBe("user_lead");
    });

    // D. No concurrent changes occur. Compensation restores every changed field correctly.
    it("Adversarial D: restores every changed field when no concurrent human modifications exist", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
          priority: "HIGH",
          title: "New Automated Task Title",
        },
      });
      expect(forwardRes.success).toBe(true);

      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(true);
      const restored = mockTaskStore.get("task_1");
      expect(restored?.status).toBe("TODO");
      expect(restored?.priority).toBe("MEDIUM");
      expect(restored?.title).toBe("Initial Task Title");
    });

    // E. A concurrency race occurs between validation and restoration.
    // Database operation under row lock must detect conflict.
    it("Adversarial E: detects race condition under row lock when task changes right at restoration", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
        },
      });
      expect(forwardRes.success).toBe(true);

      // Simulate a database-level race where updateTaskInOrg's lock check fails
      (updateTaskInOrg as jest.Mock).mockImplementationOnce(async () => {
        return {
          success: false,
          code: "UPDATE_FAILED",
          error: "CONCURRENCY_CONFLICT: Field 'status' has diverged (expected 'IN_PROGRESS', found 'DONE')",
        };
      });

      const compRes = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(false);
      expect(compRes.error).toContain("CONCURRENCY_CONFLICT");
      expect(compRes.isRetriable).toBe(false);
    });

    // F. Duplicate compensation delivery does not introduce inconsistent state.
    it("Adversarial F: duplicate compensation delivery is idempotent and does not corrupt state", async () => {
      const forwardRes = await updateTaskAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        inputs: {
          taskId: "task_1",
          status: "IN_PROGRESS",
          priority: "HIGH",
        },
      });
      expect(forwardRes.success).toBe(true);

      // First compensation delivery: succeeds and restores TODO, MEDIUM
      const firstComp = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });
      expect(firstComp.success).toBe(true);
      expect(mockTaskStore.get("task_1")?.status).toBe("TODO");
      expect(mockTaskStore.get("task_1")?.priority).toBe("MEDIUM");

      // Second compensation delivery: detects already restored / already logged, returns success idempotently
      const secondComp = await updateTaskAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_update",
        stepRunId: "sr_update_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });
      expect(secondComp.success).toBe(true);
      expect((secondComp.data as Record<string, unknown>)?.alreadyCompensated).toBe(true);

      // State remains TODO, MEDIUM
      expect(mockTaskStore.get("task_1")?.status).toBe("TODO");
      expect(mockTaskStore.get("task_1")?.priority).toBe("MEDIUM");
    });
  });

  describe("comment.create@1.0.0", () => {
    it("executes canonical worker-safe comment creation and returns comment details", async () => {
      const res = await createCommentAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_comment",
        inputs: {
          taskId: "task_1",
          content: "Automated triage note: Priority escalated to HIGH.",
          userId: "user_alice",
        },
      });

      expect(res.success).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.commentId).toBe("comment_1");
      expect(data.taskId).toBe("task_1");
      expect(data.content).toBe("Automated triage note: Priority escalated to HIGH.");
      expect(data.userId).toBe("user_alice");

      const savedComment = mockCommentStore.get("comment_1");
      expect(savedComment).toBeDefined();
      expect(savedComment?.content).toContain("Automated triage note");
    });

    it("appends an audit tombstone during rollback without deleting the original comment", async () => {
      // 1. Forward creation
      const forwardRes = await createCommentAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_comment",
        inputs: {
          taskId: "task_1",
          content: "Escalation initiated to incident API.",
        },
      });
      expect(forwardRes.success).toBe(true);

      // 2. Backward saga compensation
      expect(createCommentAction.compensate).toBeDefined();
      const compRes = await createCommentAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_comment",
        stepRunId: "sr_comment_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });

      expect(compRes.success).toBe(true);

      // Original comment must remain in store and carry the tombstone tag
      const comment = mockCommentStore.get("comment_1");
      expect(comment).toBeDefined();
      expect(comment?.content).toContain("Escalation initiated to incident API.");
      expect(comment?.content).toContain("[ROLLED BACK: Automated action rolled back due to downstream workflow failure]");

      // 3. Retry idempotency: running compensation again must NOT duplicate the tombstone tag
      const retryCompRes = await createCommentAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_comment",
        stepRunId: "sr_comment_1",
        inputs: {},
        outputs: forwardRes.data as JsonValue,
      });
      expect(retryCompRes.success).toBe(true);

      const afterRetry = mockCommentStore.get("comment_1");
      const occurrences = (afterRetry?.content.match(/\[ROLLED BACK:/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });
});
