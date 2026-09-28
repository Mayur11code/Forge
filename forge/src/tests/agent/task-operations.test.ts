// src/tests/agent/task-operations.test.ts
//
// Canonical task read/update operations and the new agent tools.
//
// The prisma double records the `where` clause of every call, so these tests
// assert the actual authorization predicate rather than just the return value.
// A read that returns the right rows for the wrong reason is still a leak.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

import { prismaDouble } from "./helpers/prisma-double";
import {
  getTaskInOrg,
  listTasksInOrg,
  resolveTaskInOrg,
} from "@/lib/tasks/read-tasks";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { executeListTasks } from "@/lib/ai/agent/tools/list-tasks";
import { executeUpdateTask } from "@/lib/ai/agent/tools/update-task";
import {
  getToolPolicy,
  requiresToolConfirmation,
} from "@/lib/ai/agent/tools/registry";

const prisma = prismaDouble as unknown as {
  task: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  membership: { findFirst: jest.Mock };
};

const CTX = {
  orgId: "org_1",
  userId: "user_a",
  executionId: "exec_1",
};

const TASK_ID = "clh7a1b2c3d4e5f6g7h8i9jkl";

/**
 * Narrow a tool executor's discriminated output to its JSON payload.
 *
 * The parameter is `unknown` so the narrowing is a single unchecked step here
 * rather than a cast at every call site.
 */
function jsonValue(output: unknown): {
  ok: boolean;
  code?: string;
  error?: string;
} {
  return (output as { value: { ok: boolean; code?: string } }).value;
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: "Fix login",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "proj_1",
    assigneeId: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    project: { name: "Website" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("task policies", () => {
  it("lists tasks without confirmation and writes with it", () => {
    expect(getToolPolicy("listTasks")).toEqual({ access: "READ_ONLY" });
    expect(requiresToolConfirmation("listTasks")).toBe(false);

    expect(getToolPolicy("updateTask")).toEqual({ access: "WRITE" });
    expect(requiresToolConfirmation("updateTask")).toBe(true);
  });
});

describe("listTasksInOrg", () => {
  it("scopes every query to the trusted org through the project relation", async () => {
    prisma.task.findMany.mockResolvedValue([taskRow()]);

    await listTasksInOrg("org_1");

    // Task has no orgId column. Filtering only on the task's own fields would
    // happily return another org's rows.
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          project: { orgId: "org_1" },
        }),
      }),
    );
  });

  it("clamps the result size server-side", async () => {
    prisma.task.findMany.mockResolvedValue([]);

    await listTasksInOrg("org_1", { take: 5_000 });

    expect(prisma.task.findMany.mock.calls[0]![0]).toMatchObject({
      take: 100,
    });
  });
});

describe("getTaskInOrg", () => {
  it("never returns a task from another org", async () => {
    prisma.task.findFirst.mockResolvedValue(null);

    const result = await getTaskInOrg("org_1", "task_from_other_org");

    expect(result).toBeNull();
    expect(prisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "task_from_other_org",
          project: { orgId: "org_1" },
        },
      }),
    );
  });
});

describe("resolveTaskInOrg", () => {
  it("prefers a direct id hit", async () => {
    prisma.task.findFirst.mockResolvedValue(taskRow());

    const result = await resolveTaskInOrg("org_1", TASK_ID);

    expect(result.kind).toBe("FOUND");
  });

  it("reports ambiguity rather than picking a task to mutate", async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      taskRow({ id: "task_a" }),
      taskRow({ id: "task_b" }),
    ]);

    const result = await resolveTaskInOrg("org_1", "Fix login");

    expect(result.kind).toBe("AMBIGUOUS");
  });
});

describe("updateTaskInOrg", () => {
  it("refuses to update a task outside the trusted org", async () => {
    prisma.task.findFirst.mockResolvedValue(null);

    const result = await updateTaskInOrg(
      { taskId: TASK_ID, status: "DONE" },
      { orgId: "org_1" },
    );

    expect(result).toMatchObject({
      success: false,
      code: "TASK_NOT_FOUND",
    });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it("writes only the fields the caller supplied", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });
    prisma.task.update.mockResolvedValue(
      taskRow({ status: "DONE" }),
    );

    const result = await updateTaskInOrg(
      { taskId: TASK_ID, status: "DONE" },
      { orgId: "org_1" },
    );

    expect(result.success).toBe(true);
    // A status change must not blank the priority or drop the assignee.
    expect(prisma.task.update.mock.calls[0]![0]).toMatchObject({
      data: { status: "DONE" },
    });
  });

  it("rejects an assignee who is not a member of the org", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });
    prisma.membership.findFirst.mockResolvedValue(null);

    const result = await updateTaskInOrg(
      {
        taskId: TASK_ID,
        assigneeId: "clhoutsiderxxxxxxxxxxxx",
      },
      { orgId: "org_1" },
    );

    expect(result).toMatchObject({
      success: false,
      code: "ASSIGNEE_NOT_FOUND",
    });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it("treats an explicit null assignee as unassign, not as omitted", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });
    prisma.task.update.mockResolvedValue(taskRow({ assigneeId: null }));

    await updateTaskInOrg(
      { taskId: TASK_ID, assigneeId: null },
      { orgId: "org_1" },
    );

    expect(prisma.task.update.mock.calls[0]![0]).toMatchObject({
      data: { assignee: { disconnect: true } },
    });
  });

  it("rejects a no-op update instead of reporting success", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });

    const result = await updateTaskInOrg(
      { taskId: TASK_ID },
      { orgId: "org_1" },
    );

    expect(result).toMatchObject({
      success: false,
      code: "NO_CHANGES",
    });
  });
});

describe("listTasks tool executor", () => {
  it("rejects an injected orgId instead of honouring it", async () => {
    const output = await executeListTasks(
      { orgId: "org_attacker", limit: 5 },
      CTX,
    );
    const value = jsonValue(output);

    // `.strict()` refuses the unknown key outright, so the request never
    // reaches the database at all.
    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });

  it("scopes a well-formed request to the session's org", async () => {
    prisma.task.findMany.mockResolvedValue([taskRow()]);

    await executeListTasks({ limit: 5, status: "TODO" }, CTX);

    expect(prisma.task.findMany.mock.calls[0]![0]).toMatchObject({
      where: expect.objectContaining({
        project: { orgId: "org_1" },
        status: "TODO",
      }),
    });
  });

  it("rejects a malformed payload", async () => {
    const output = await executeListTasks({ limit: "many" }, CTX);
    const value = jsonValue(output);

    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
});

describe("updateTask tool executor", () => {
  it("requires at least one field to change", async () => {
    const output = await executeUpdateTask(
      { taskTitle: "Fix login" },
      CTX,
    );
    const value = jsonValue(output);

    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it("refuses to mutate a task it could not resolve", async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([]);

    const output = await executeUpdateTask(
      { taskTitle: "Nonexistent", status: "DONE" },
      CTX,
    );
    const value = jsonValue(output);

    expect(value.ok).toBe(false);
    expect(value.code).toBe("TASK_NOT_FOUND");
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it("stops and asks the user when the title is ambiguous", async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      taskRow({ id: "task_a" }),
      taskRow({ id: "task_b" }),
    ]);

    const output = await executeUpdateTask(
      { taskTitle: "Fix login", status: "DONE" },
      CTX,
    );
    const value = jsonValue(output);

    expect(value.code).toBe("TASK_AMBIGUOUS");
    // Guessing which task the user meant could mark the wrong one done.
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
});
