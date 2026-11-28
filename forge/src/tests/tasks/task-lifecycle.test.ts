jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    task: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    membership: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    task: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    domainEventOutbox: {
      create: jest.fn().mockResolvedValue({ id: "dom_1" }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("@/lib/vector/outbox", () => ({
  recordVectorSyncIntent: jest.fn().mockResolvedValue({ id: "v-outbox-1" }),
}));

jest.mock("@/lib/events/event-bus", () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { prisma } from "@/lib/prisma/extended";
import { dispatchEvent } from "@/lib/events/event-bus";
import { updateTaskInOrgAction } from "@/app/actions/Tasks/updateTaskInOrg";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { TaskStatus, TaskPriority } from "@prisma/client";

describe("Interactive Task Lifecycle & Domain Events (FC-009)", () => {
  const taskId = "c123456789012345678901234";
  const projectId = "c123456789012345678909999";
  const orgId = "org-alpha-1";
  const orgSlug = "alpha-corp";
  const userId = "user-123";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateTaskInOrgAction Server Boundary & Tenant Isolation", () => {
    it("rejects unauthenticated requests", async () => {
      (auth as jest.Mock).mockResolvedValue(null);

      const res = await updateTaskInOrgAction({
        taskId,
        status: TaskStatus.IN_PROGRESS,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain("Unauthorized");
      }
    });

    it("rejects cross-tenant task update (Org A caller cannot modify Org B task)", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: userId },
      });

      // Task belongs to Org B
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId,
        project: {
          orgId: "org-beta-999",
          organization: {
            id: "org-beta-999",
            slug: "beta-corp",
          },
        },
      });

      // Caller's membership in beta-corp returns null (belongs only to alpha-corp)
      (getOrgAccess as jest.Mock).mockResolvedValue(null);

      const res = await updateTaskInOrgAction({
        taskId,
        status: TaskStatus.DONE,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain("Forbidden: Cross-tenant access denied.");
      }
    });
  });

  describe("Canonical Task Lifecycle & CDC Event Emission", () => {
    it("moving task to DONE sets completedAt timestamp and dispatches both TASK_UPDATED and TASK_COMPLETED", async () => {
      // 1. Existing task in org
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId,
      });

      // 2. Transaction mock execution
      const updatedRecord = {
        id: taskId,
        projectId,
        title: "Deploy V2 Infrastructure",
        description: "Deploying core cluster",
        status: TaskStatus.DONE,
        priority: TaskPriority.HIGH,
        assigneeId: null,
        completedAt: new Date(),
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const txMock = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          task: {
            findFirst: jest.fn().mockResolvedValue({
              id: taskId,
              projectId,
              status: TaskStatus.TODO,
              title: "Deploy V2 Infrastructure",
              priority: TaskPriority.HIGH,
              assigneeId: null,
              description: "Deploying core cluster",
            }),
            update: jest.fn().mockResolvedValue(updatedRecord),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          attachment: {
            findMany: jest.fn().mockResolvedValue([]),
          },
          domainEventOutbox: {
            create: jest.fn().mockResolvedValue({ id: "dom_1" }),
          },
        };
        return callback(txMock);
      });

      const result = await updateTaskInOrg(
        { taskId, status: TaskStatus.DONE },
        { orgId, userId }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.task.status).toBe(TaskStatus.DONE);
      }

      // Verify TASK_UPDATED dispatch
      expect(dispatchEvent).toHaveBeenCalledWith(
        "TASK_UPDATED",
        expect.objectContaining({
          taskId,
          orgId,
          projectId,
        })
      );

      // Verify TASK_COMPLETED dispatch
      expect(dispatchEvent).toHaveBeenCalledWith(
        "TASK_COMPLETED",
        expect.objectContaining({
          taskId,
          orgId,
          projectId,
        })
      );
    });

    it("moving task out of DONE back to IN_PROGRESS resets completedAt to null and dispatches TASK_UPDATED only", async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId,
      });

      let updatePayloadPassedToTx: Record<string, unknown> | null = null;

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const txMock = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          task: {
            findFirst: jest.fn().mockResolvedValue({
              id: taskId,
              projectId,
              status: TaskStatus.DONE,
              title: "Deploy V2 Infrastructure",
              priority: TaskPriority.HIGH,
              assigneeId: null,
              description: null,
            }),
            update: jest.fn().mockImplementation((args) => {
              updatePayloadPassedToTx = args.data;
              return Promise.resolve({
                id: taskId,
                projectId,
                title: "Deploy V2 Infrastructure",
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.HIGH,
                assigneeId: null,
                completedAt: null,
              });
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          attachment: {
            findMany: jest.fn().mockResolvedValue([]),
          },
          domainEventOutbox: {
            create: jest.fn().mockResolvedValue({ id: "dom_1" }),
          },
        };
        return callback(txMock);
      });

      const result = await updateTaskInOrg(
        { taskId, status: TaskStatus.IN_PROGRESS },
        { orgId, userId }
      );

      expect(result.success).toBe(true);
      expect(updatePayloadPassedToTx).toEqual({
        status: TaskStatus.IN_PROGRESS,
        completedAt: null,
      });

      // Dispatches TASK_UPDATED
      expect(dispatchEvent).toHaveBeenCalledWith(
        "TASK_UPDATED",
        expect.objectContaining({
          taskId,
          orgId,
        })
      );

      // Does NOT dispatch TASK_COMPLETED
      expect(dispatchEvent).not.toHaveBeenCalledWith(
        "TASK_COMPLETED",
        expect.anything()
      );
    });

    it("supports transitioning task to BLOCKED status", async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId,
      });

      let updatePayloadPassedToTx: Record<string, unknown> | null = null;

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const txMock = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          task: {
            findFirst: jest.fn().mockResolvedValue({
              id: taskId,
              projectId,
              status: TaskStatus.TODO,
              title: "Deploy V2 Infrastructure",
              priority: TaskPriority.HIGH,
              assigneeId: null,
              description: null,
            }),
            update: jest.fn().mockImplementation((args) => {
              updatePayloadPassedToTx = args.data;
              return Promise.resolve({
                id: taskId,
                projectId,
                title: "Deploy V2 Infrastructure",
                status: TaskStatus.BLOCKED,
                priority: TaskPriority.HIGH,
                assigneeId: null,
                completedAt: null,
              });
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          attachment: {
            findMany: jest.fn().mockResolvedValue([]),
          },
          domainEventOutbox: {
            create: jest.fn().mockResolvedValue({ id: "dom_1" }),
          },
        };
        return callback(txMock);
      });

      const result = await updateTaskInOrg(
        { taskId, status: TaskStatus.BLOCKED },
        { orgId, userId }
      );

      expect(result.success).toBe(true);
      expect(updatePayloadPassedToTx).toMatchObject({ status: TaskStatus.BLOCKED });
      expect(dispatchEvent).toHaveBeenCalledWith(
        "TASK_UPDATED",
        expect.objectContaining({ taskId, orgId })
      );
    });

    it("updating priority emits TASK_UPDATED CDC event", async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        id: taskId,
        projectId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const txMock = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          task: {
            findFirst: jest.fn().mockResolvedValue({
              id: taskId,
              projectId,
              status: TaskStatus.TODO,
              title: "Deploy V2 Infrastructure",
              priority: TaskPriority.LOW,
              assigneeId: null,
              description: null,
            }),
            update: jest.fn().mockResolvedValue({
              id: taskId,
              projectId,
              title: "Deploy V2 Infrastructure",
              status: TaskStatus.TODO,
              priority: TaskPriority.HIGH,
              assigneeId: null,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          attachment: {
            findMany: jest.fn().mockResolvedValue([]),
          },
          domainEventOutbox: {
            create: jest.fn().mockResolvedValue({ id: "dom_1" }),
          },
        };
        return callback(txMock);
      });

      const result = await updateTaskInOrg(
        { taskId, priority: TaskPriority.HIGH },
        { orgId, userId }
      );

      expect(result.success).toBe(true);
      expect(dispatchEvent).toHaveBeenCalledWith(
        "TASK_UPDATED",
        expect.objectContaining({
          taskId,
          orgId,
        })
      );
    });
  });
});
