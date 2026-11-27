// src/lib/workflow/actions/core/generate-report.ts
import { ExecuteFunction, CompensateFunction, WorkflowAction } from "../../../workflow-types/type";
import { utapi } from "@/lib/uploadThing/uploadthing-server";
import { db } from "@/lib/prisma/db";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { projectId, title, userName, templateId } = ctx.inputs;

    // 1. Resolve trusted org boundary from persisted Workflow
    let orgId = "unknown-org";
    let workflowName = "Workflow Report";
    if (ctx.workflowId) {
      const workflow = await db.workflow.findUnique({
        where: { id: ctx.workflowId },
        select: { orgId: true, name: true },
      });
      if (workflow) {
        orgId = workflow.orgId;
        workflowName = workflow.name;
      }
    }

    // 2. Query real tasks for this organization (and optional projectId)
    const targetProjectId = typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined;
    let tasks: Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
      createdAt: Date;
      assignee?: { name: string | null; email: string | null } | null;
      project?: { name: string } | null;
    }> = [];

    try {
      tasks = await db.task.findMany({
        where: {
          project: { orgId },
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
        },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          createdAt: true,
          assignee: { select: { name: true, email: true } },
          project: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    } catch (dbErr) {
      // In case task table or project relation is mocked or empty
      console.warn("[ACTION: report.generate] Task query completed with fallback:", dbErr);
    }

    const totalTasks = tasks.length;
    const todoCount = tasks.filter((t) => t.status === "TODO").length;
    const inProgressCount = tasks.filter((t) => t.status === "IN_PROGRESS").length;
    const blockedCount = tasks.filter((t) => t.status === "BLOCKED").length;
    const doneCount = tasks.filter((t) => t.status === "DONE").length;

    const highPriorityCount = tasks.filter((t) => t.priority === "HIGH").length;
    const mediumPriorityCount = tasks.filter((t) => t.priority === "MEDIUM").length;
    const lowPriorityCount = tasks.filter((t) => t.priority === "LOW").length;

    const reportTitle = typeof title === "string" && title.trim() ? title.trim() : `${workflowName} Progress Digest`;
    const requestedBy = typeof userName === "string" && userName.trim() ? userName.trim() : "System Automation";
    const reportDate = new Date().toISOString();

    const taskRows = tasks.slice(0, 15).map((t) => {
      const safeTitle = t.title.replace(/\|/g, "-");
      const assigneeName = t.assignee?.name || t.assignee?.email || "Unassigned";
      return `| ${t.id.slice(0, 8)} | ${safeTitle} | ${t.status} | ${t.priority} | ${assigneeName} |`;
    }).join("\n");

    const reportContent = [
      `# ${reportTitle}`,
      "",
      "## Overview",
      `- **Generated At:** ${reportDate}`,
      `- **Organization ID:** ${orgId}`,
      `- **Requested By:** ${requestedBy}`,
      targetProjectId ? `- **Project ID:** ${targetProjectId}` : "- **Scope:** Organization-wide",
      templateId ? `- **Template:** ${templateId}` : "",
      "",
      "## Executive Summary",
      `| Metric | Count | Percentage |`,
      `| :--- | :---: | :---: |`,
      `| Total Tasks | ${totalTasks} | 100% |`,
      `| Completed (DONE) | ${doneCount} | ${totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0}% |`,
      `| In Progress | ${inProgressCount} | ${totalTasks > 0 ? Math.round((inProgressCount / totalTasks) * 100) : 0}% |`,
      `| Blocked | ${blockedCount} | ${totalTasks > 0 ? Math.round((blockedCount / totalTasks) * 100) : 0}% |`,
      `| Todo | ${todoCount} | ${totalTasks > 0 ? Math.round((todoCount / totalTasks) * 100) : 0}% |`,
      "",
      "## Priority Breakdown",
      `| Priority | Count |`,
      `| :--- | :---: |`,
      `| HIGH | ${highPriorityCount} |`,
      `| MEDIUM | ${mediumPriorityCount} |`,
      `| LOW | ${lowPriorityCount} |`,
      "",
      "## Recent Tasks",
      `| ID | Title | Status | Priority | Assignee |`,
      `| :--- | :--- | :---: | :---: | :--- |`,
      taskRows || "| - | No tasks recorded | - | - | - |",
      "",
      "---",
      "*Generated automatically by Forge Workflow Engine.*",
    ].filter(Boolean).join("\n");

    const sanitizedTitle = reportTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const fileName = `report-${sanitizedTitle}-${Date.now()}.md`;
    const file = new File([reportContent], fileName, {
      type: "text/markdown",
    });

    console.log(`[ACTION: report.generate] Uploading ${fileName} (${file.size} bytes) to UploadThing...`);

    const uploadResult = await utapi.uploadFiles(file);

    if (uploadResult.error) {
      return {
        success: false,
        error: `UploadThing Error: ${uploadResult.error.message}`,
        isRetriable: true,
      };
    }

    const documentUrl = uploadResult.data.url;
    const fileKey = uploadResult.data.key;

    return {
      success: true,
      data: {
        documentUrl,
        fileKey,
        fileName: uploadResult.data.name,
        sizeBytes: uploadResult.data.size,
        markdownContent: reportContent,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, "Failed to generate or upload report"),
      isRetriable: true,
    };
  }
};

const compensate: CompensateFunction = async (ctx) => {
  try {
    const outputs = ctx.outputs;
    const fileKey =
      typeof outputs === "object" &&
      outputs !== null &&
      !Array.isArray(outputs) &&
      typeof (outputs as Record<string, unknown>).fileKey === "string"
        ? ((outputs as Record<string, unknown>).fileKey as string)
        : undefined;

    if (!fileKey) {
      console.warn(`[ACTION: report.generate] No fileKey found in outputs. Skipping compensation.`);
      return { success: true };
    }

    console.log(`[ACTION: report.generate] ROLLING BACK: Deleting file ${fileKey} from UploadThing...`);
    const deleteResult = await utapi.deleteFiles(fileKey);

    if (!deleteResult.success) {
      return {
        success: false,
        error: "UploadThing failed to delete the artifact during rollback",
        isRetriable: true,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, "Fatal error during report compensation"),
      isRetriable: true,
    };
  }
};

export const generateReportAction: WorkflowAction = {
  id: "report.generate",
  version: "1.0.0",
  execute,
  compensate,
};
