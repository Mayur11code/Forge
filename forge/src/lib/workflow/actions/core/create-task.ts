// src/lib/workflow/actions/core/create-task.ts
//
// Thin worker-safe adapter for the `task.create` workflow action.
//
// Trust model:
// - The trusted org is resolved from the PERSISTED Workflow row, never from
//   `ctx.inputs`. A workflow can therefore only ever create tasks inside its
//   own organization.
// - `projectId` arrives from resolved workflow node config and is still
//   UNTRUSTED: the canonical operation re-verifies that it belongs to the
//   workflow's org before writing.
// - A WorkflowRun has no interactive user, so no userId is supplied.
//
// The write goes through the canonical operation, so this path uses the
// EXTENDED Prisma client and fires the TASK_CREATED CDC exactly like the UI
// and agent paths. It must not call `db.task.create` directly.

import { ExecuteFunction, WorkflowAction } from "../../../workflow-types/type";
import { db } from "@/lib/prisma/db";
import { createTaskInOrg } from "@/lib/tasks/create-task";

const execute: ExecuteFunction = async (ctx) => {
  try {
    // 1. Inputs were already resolved by the engine (pointers replaced).
    const { title, projectId, description, priority, assigneeId } = ctx.inputs;

    if (!title || !projectId) {
      return {
        success: false,
        error: "Missing required fields: title or projectId",
        isRetriable: false, // Bad user config, retrying won't fix this
      };
    }

    // 2. Trusted org: read from the persisted Workflow record.
    const workflow = await db.workflow.findUnique({
      where: { id: ctx.workflowId },
      select: { orgId: true },
    });

    if (!workflow) {
      return {
        success: false,
        error: "Workflow not found",
        isRetriable: false,
      };
    }

    console.log(
      `[ACTION: task.create] Creating task "${title}" in project ${projectId} (org ${workflow.orgId})...`,
    );

    // 3. Canonical business operation.
    const result = await createTaskInOrg(
      { title, projectId, description, priority, assigneeId },
      { orgId: workflow.orgId },
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        isRetriable: result.code === "CREATE_FAILED",
      };
    }

    // 4. Return the exact standardized payload
    return {
      success: true,
      data: { taskId: result.task.id, title: result.task.title }, // Piped into Global Context
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Database connection failed",
      isRetriable: true, // Database timeout? Let QStash try again.
    };
  }
};

// Export the fully formed action object
export const createTaskAction: WorkflowAction = {
  id: "task.create",
  execute,
  // compensate: async (ctx) => { ... } // For Phase 6
};
