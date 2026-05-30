// src/lib/workflow/actions/core/create-task.ts
import { ExecuteFunction, WorkflowAction } from "../../../workflow-types/type";
import { db } from "@/lib/prisma/db";

const execute: ExecuteFunction = async (ctx) => {
  try {
    // 1. The inputs are already resolved by the engine before this runs
    const { title, projectId, description } = ctx.inputs;

    if (!title || !projectId) {
      return { 
        success: false, 
        error: "Missing required fields: title or projectId", 
        isRetriable: false // Bad user config, retrying won't fix this
      };
    }
console.log(`[ACTION: task.create] Creating task with title "${title}" in project ${projectId}...`);
    // 2. Execute the actual business logic
    const task = await db.task.create({
      data: {
        title,
        projectId,
        description: description || "",
        status: "TODO",
      }
    });

    // 3. Return the exact standardized payload
    return {
      success: true,
      data: { taskId: task.id, title: task.title } // This gets piped to Global Context!
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Database connection failed",
      isRetriable: true // Database timeout? Let QStash try again.
    };
  }
};

// Export the fully formed action object
export const createTaskAction: WorkflowAction = {
  id: "task.create",
  execute,
  // compensate: async (ctx) => { await db.task.delete(...) } // For Phase 6
};