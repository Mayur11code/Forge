// src/tests/workflow/automation-scenarios.test.ts
//
// M5 FC-023: End-to-End Verification of Three Real Business Automation Scenarios.
//
// Scenarios verified:
// 1. Scenario 1 (Auto-Triage):
//    `task.created` (HIGH) -> `task.update` (Assign Lead & Status: IN_PROGRESS) -> `email.send` (Resend Notification).
// 2. Scenario 2 (Progress Digest):
//    Trigger -> `report.generate` (Compile Real Markdown Table Artifact) -> `comment.create` -> `email.send`.
// 3. Scenario 3 (Escalation & Saga Rollback):
//    `task.updated` (BLOCKED) -> `comment.create` -> `task.update` (escalate) -> `http.request` (fails 500)
//    -> Reverse Saga Rollback restores `BLOCKED` status and appends rollback tombstone note.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

const mockSentEmails: Array<{ to: string; subject: string; html: string }> = [];
jest.mock("@/lib/emails/core-service", () => ({
  executeSendEmail: jest.fn().mockImplementation((params) => {
    mockSentEmails.push(params);
    return Promise.resolve({ id: `msg_${Date.now()}`, deliveredTo: params.to });
  }),
}));

const mockUploadedFiles: Array<{ name: string; content: string }> = [];
const mockDeletedFiles: string[] = [];
jest.mock("@/lib/uploadThing/uploadthing-server", () => ({
  utapi: {
    uploadFiles: jest.fn().mockImplementation(async (file: File) => {
      const text = await file.text();
      mockUploadedFiles.push({ name: file.name, content: text });
      return {
        data: {
          url: `https://utfs.io/f/${file.name}`,
          key: `key_${file.name}`,
          name: file.name,
          size: file.size,
        },
      };
    }),
    deleteFiles: jest.fn().mockImplementation((key: string) => {
      mockDeletedFiles.push(key);
      return Promise.resolve({ success: true });
    }),
  },
}));

// In-memory store for Tasks, Comments, Workflows, Runs, StepRuns, and Audits
const taskStore = new Map<string, {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  assigneeId: string | null;
  projectId: string;
  createdAt: Date;
}>();

const commentStore = new Map<string, {
  id: string;
  content: string;
  taskId: string;
  userId: string;
  createdAt: Date;
}>();

const auditLogStore: Array<{ runId: string; stepId: string; eventType: string; message: string; payload: unknown }> = [];

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        return Promise.resolve({
          id: where.id,
          orgId: "org_forge_demo",
          name: "Automation Workflow",
        });
      }),
    },
    task: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string; project?: { orgId: string } } }) => {
        const task = taskStore.get(where.id);
        if (!task) return Promise.resolve(null);
        return Promise.resolve({ ...task, project: { orgId: "org_forge_demo" } });
      }),
      findMany: jest.fn().mockImplementation(() => {
        return Promise.resolve(Array.from(taskStore.values()).map((t) => ({
          ...t,
          assignee: t.assigneeId ? { name: "Lead Engineer", email: "lead@example.com" } : null,
          project: { name: "Core Engine" },
        })));
      }),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = taskStore.get(where.id);
        if (!existing) throw new Error("Task not found");
        const updated = { ...existing, ...data };
        taskStore.set(where.id, updated as typeof existing);
        return Promise.resolve(updated);
      }),
    },
    comment: {
      create: jest.fn().mockImplementation(({ data }: { data: { content: string; taskId: string; userId: string } }) => {
        const id = `comment_${commentStore.size + 1}`;
        const newComment = { id, ...data, createdAt: new Date() };
        commentStore.set(id, newComment);
        return Promise.resolve(newComment);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const c = commentStore.get(where.id);
        return Promise.resolve(c ? { ...c } : null);
      }),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: { content: string } }) => {
        const c = commentStore.get(where.id);
        if (!c) throw new Error("Comment not found");
        const updated = { ...c, ...data };
        commentStore.set(where.id, updated);
        return Promise.resolve(updated);
      }),
      delete: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        commentStore.delete(where.id);
        return Promise.resolve({ id: where.id });
      }),
    },
    membership: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { orgId: string; userId?: string } }) => {
        return Promise.resolve({ userId: where.userId || "user_lead", role: "ADMIN" });
      }),
    },
    executionAuditLog: {
      create: jest.fn().mockImplementation(({ data }: { data: { runId: string; stepId: string; eventType: string; message: string; payload: unknown } }) => {
        auditLogStore.push(data);
        return Promise.resolve(data);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: { where: { runId?: string; stepId?: string; eventType?: string } }) => {
        const found = auditLogStore.find((a) =>
          (!where.runId || a.runId === where.runId) &&
          (!where.stepId || a.stepId === where.stepId) &&
          (!where.eventType || a.eventType === where.eventType),
        );
        return Promise.resolve(found || null);
      }),
    },
  },
}));

jest.mock("@/lib/tasks/update-task", () => ({
  updateTaskInOrg: jest.fn().mockImplementation(async (changes: Record<string, unknown>, actor?: { expectedState?: Record<string, unknown> }) => {
    const { taskId, ...data } = changes as { taskId: string; [key: string]: unknown };
    const task = taskStore.get(taskId);
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
    taskStore.set(taskId, updated as typeof task);
    return { success: true, task: updated };
  }),
}));

import { EventEmitter } from "node:events";
import type http from "node:http";
import { getAction } from "@/lib/workflow-types/action-registry";
import { __setTestHttpRequestHooks } from "@/lib/workflow/actions/core/http-request";
import type { JsonValue } from "@/lib/workflow-types/type";
import { resolveInputs } from "@/lib/workflow/execution/resolver";

describe("M5 FC-023: Three Real Business Automation Scenarios", () => {
  beforeEach(() => {
    taskStore.clear();
    commentStore.clear();
    auditLogStore.length = 0;
    mockSentEmails.length = 0;
    mockUploadedFiles.length = 0;
    mockDeletedFiles.length = 0;
    jest.clearAllMocks();

    // Seed initial task
    taskStore.set("task_100", {
      id: "task_100",
      title: "Memory leak in query cache",
      status: "TODO",
      priority: "HIGH",
      description: "Severe allocation spike under concurrency",
      assigneeId: null,
      projectId: "proj_engine",
      createdAt: new Date(),
    });
  });

  // =========================================================================
  // Scenario 1: Automatic Task Triage & Assignment
  // =========================================================================
  it("Scenario 1 (Auto-Triage): task.created (HIGH) -> task.update (Assign Lead & IN_PROGRESS) -> email.send", async () => {
    const triggerData = {
      taskId: "task_100",
      projectId: "proj_engine",
      title: "Memory leak in query cache",
      priority: "HIGH",
      status: "TODO",
    };

    const globalContext: Record<string, JsonValue> = {
      trigger: { outputs: triggerData },
    };

    // Step 1: task.update action
    const updateAction = getAction("task.update", "1.0.0");
    expect(updateAction).toBeDefined();

    const updateRawInputs = {
      taskId: "{{trigger.outputs.taskId}}",
      status: "IN_PROGRESS",
      priority: "HIGH",
      assigneeId: "user_lead",
    };
    const resolvedUpdateInputs = resolveInputs(updateRawInputs, globalContext);

    const updateResult = await updateAction!.execute({
      workflowId: "wf_triage",
      runId: "run_s1",
      stepId: "step_triage_update",
      inputs: resolvedUpdateInputs,
    });

    expect(updateResult.success).toBe(true);
    globalContext["step_triage_update"] = { outputs: (updateResult.data ?? null) as JsonValue };

    // Assert Task in DB was updated to IN_PROGRESS and assigned to user_lead
    const updatedTask = taskStore.get("task_100");
    expect(updatedTask?.status).toBe("IN_PROGRESS");
    expect(updatedTask?.priority).toBe("HIGH");
    expect(updatedTask?.assigneeId).toBe("user_lead");

    // Step 2: email.send action
    const emailAction = getAction("email.send", "1.0.0");
    expect(emailAction).toBeDefined();

    const emailRawInputs = {
      toEmail: "lead@example.com",
      subject: "Urgent Task Assigned: {{trigger.outputs.title}}",
      bodyText: "Task {{trigger.outputs.taskId}} has been auto-triaged to IN_PROGRESS and assigned to you.",
    };
    const resolvedEmailInputs = resolveInputs(emailRawInputs, globalContext);

    const emailResult = await emailAction!.execute({
      workflowId: "wf_triage",
      runId: "run_s1",
      stepId: "step_triage_email",
      inputs: resolvedEmailInputs,
    });

    expect(emailResult.success).toBe(true);
    expect(mockSentEmails.length).toBe(1);
    expect(mockSentEmails[0].to).toBe("lead@example.com");
    expect(mockSentEmails[0].subject).toBe("Urgent Task Assigned: Memory leak in query cache");
    expect(mockSentEmails[0].html).toContain("Task task_100 has been auto-triaged");
  });

  // =========================================================================
  // Scenario 2: Automated Progress Digest & Report Generation
  // =========================================================================
  it("Scenario 2 (Progress Digest): report.generate (Markdown Table & Upload) -> comment.create -> email.send", async () => {
    // Seed additional task records for the report
    taskStore.set("task_101", {
      id: "task_101",
      title: "UI button contrast issue",
      status: "DONE",
      priority: "LOW",
      description: null,
      assigneeId: "user_lead",
      projectId: "proj_engine",
      createdAt: new Date(),
    });
    taskStore.set("task_102", {
      id: "task_102",
      title: "Deadlock in worker lock release",
      status: "BLOCKED",
      priority: "HIGH",
      description: null,
      assigneeId: null,
      projectId: "proj_engine",
      createdAt: new Date(),
    });

    const triggerData = {
      projectId: "proj_engine",
      requestedBy: "Engineering Director",
      taskId: "task_100",
    };

    const globalContext: Record<string, JsonValue> = {
      trigger: { outputs: triggerData },
    };

    // Step 1: report.generate action
    const reportAction = getAction("report.generate", "1.0.0");
    expect(reportAction).toBeDefined();

    const reportRawInputs = {
      projectId: "{{trigger.outputs.projectId}}",
      title: "Sprint Progress Audit",
      userName: "{{trigger.outputs.requestedBy}}",
    };
    const resolvedReportInputs = resolveInputs(reportRawInputs, globalContext);

    const reportResult = await reportAction!.execute({
      workflowId: "wf_digest",
      runId: "run_s2",
      stepId: "step_digest_report",
      inputs: resolvedReportInputs,
    });

    expect(reportResult.success).toBe(true);
    const reportData = reportResult.data as Record<string, unknown>;
    expect(reportData.documentUrl).toContain("https://utfs.io/f/");
    expect(mockUploadedFiles.length).toBe(1);
    expect(mockUploadedFiles[0].content).toContain("# Sprint Progress Audit");
    expect(mockUploadedFiles[0].content).toContain("Total Tasks | 3 | 100%");
    expect(mockUploadedFiles[0].content).toContain("Completed (DONE) | 1 | 33%");

    globalContext["step_digest_report"] = { outputs: (reportResult.data ?? null) as JsonValue };

    // Step 2: comment.create action
    const commentAction = getAction("comment.create", "1.0.0");
    expect(commentAction).toBeDefined();

    const commentRawInputs = {
      taskId: "{{trigger.outputs.taskId}}",
      content: "Weekly digest generated:\nArtifact: {{step_digest_report.outputs.documentUrl}}",
    };
    const resolvedCommentInputs = resolveInputs(commentRawInputs, globalContext);

    const commentResult = await commentAction!.execute({
      workflowId: "wf_digest",
      runId: "run_s2",
      stepId: "step_digest_comment",
      inputs: resolvedCommentInputs,
    });

    expect(commentResult.success).toBe(true);
    const commentData = commentResult.data as Record<string, unknown>;
    expect(commentStore.has(commentData.commentId as string)).toBe(true);
    expect(commentStore.get(commentData.commentId as string)?.content).toContain("Weekly digest generated:");
    expect(commentStore.get(commentData.commentId as string)?.content).toContain("https://utfs.io/f/");

    globalContext["step_digest_comment"] = { outputs: (commentResult.data ?? null) as JsonValue };

    // Step 3: email.send action
    const emailAction = getAction("email.send", "1.0.0");
    const emailRawInputs = {
      toEmail: "stakeholder@example.com",
      subject: "Weekly Digest Ready: proj_engine",
      bodyText: "Review report at: {{step_digest_report.outputs.documentUrl}}",
      attachmentUrl: "{{step_digest_report.outputs.documentUrl}}",
      attachmentName: "progress-report.md",
    };
    const resolvedEmailInputs = resolveInputs(emailRawInputs, globalContext);

    const emailResult = await emailAction!.execute({
      workflowId: "wf_digest",
      runId: "run_s2",
      stepId: "step_digest_email",
      inputs: resolvedEmailInputs,
    });

    expect(emailResult.success).toBe(true);
    expect(mockSentEmails.length).toBe(1);
    expect(mockSentEmails[0].to).toBe("stakeholder@example.com");
    expect(mockSentEmails[0].html).toContain("https://utfs.io/f/");
  });

  // =========================================================================
  // Scenario 3: Task Escalation with Compensating Action (Saga Rollback)
  // =========================================================================
  it("Scenario 3 (Escalation & Rollback): task.updated (BLOCKED) -> comment.create -> task.update (escalate) -> http.request (500) -> Saga Rollback restores BLOCKED and appends tombstone", async () => {
    // Initial task is BLOCKED
    taskStore.set("task_blocked", {
      id: "task_blocked",
      title: "Outage: Auth service unreachable",
      status: "BLOCKED",
      priority: "MEDIUM",
      description: "Downstream auth service times out",
      assigneeId: null,
      projectId: "proj_engine",
      createdAt: new Date(),
    });

    const triggerData = {
      taskId: "task_blocked",
      status: "BLOCKED",
      priority: "MEDIUM",
    };

    const globalContext: Record<string, JsonValue> = {
      trigger: { outputs: triggerData },
    };

    // Step 1: comment.create initial audit note
    const commentAction = getAction("comment.create", "1.0.0");
    const commentRes = await commentAction!.execute({
      workflowId: "wf_escalation",
      runId: "run_s3",
      stepId: "step_audit_comment",
      inputs: {
        taskId: "task_blocked",
        content: "Automated escalation initiated to incident paging system.",
      },
    });
    expect(commentRes.success).toBe(true);
    const commentOutputs = commentRes.data as Record<string, unknown>;
    globalContext["step_audit_comment"] = { outputs: (commentRes.data ?? null) as JsonValue };

    // Step 2: task.update (temporarily escalate status to IN_PROGRESS, priority to HIGH)
    const updateAction = getAction("task.update", "1.0.0");
    const updateRes = await updateAction!.execute({
      workflowId: "wf_escalation",
      runId: "run_s3",
      stepId: "step_escalate_task",
      inputs: {
        taskId: "task_blocked",
        status: "IN_PROGRESS",
        priority: "HIGH",
      },
    });
    expect(updateRes.success).toBe(true);
    const updateOutputs = updateRes.data as Record<string, unknown>;
    globalContext["step_escalate_task"] = { outputs: (updateRes.data ?? null) as JsonValue };

    // Verify task in DB is temporarily escalated
    expect(taskStore.get("task_blocked")?.status).toBe("IN_PROGRESS");
    expect(taskStore.get("task_blocked")?.priority).toBe("HIGH");

    // Step 3: http.request simulating upstream external API 500 error
    // In accordance with UPPR Rev 4.1 Phase 2, inject a deterministic test transport seam
    // that passes full SSRF scheme, hostname, and public IP validation without making external network calls.
    const httpAction = getAction("http.request", "1.0.0");
    const allowedPublicUrl = "https://incident-alerts.ops-monitor.com/api/v1/page";

    const mock500Transport = ((
      _options: unknown,
      callback: (res: http.IncomingMessage) => void,
    ) => {
      const responseStream = Object.assign(new EventEmitter(), {
        statusCode: 500,
        statusMessage: "Internal Server Error",
        headers: { "content-type": "application/json" },
      }) as unknown as http.IncomingMessage;

      process.nextTick(() => {
        callback(responseStream);
        responseStream.emit("data", Buffer.from(JSON.stringify({ error: "Remote incident gateway 500: Server Overloaded" })));
        responseStream.emit("end");
      });

      const clientReq = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        setTimeout: jest.fn(),
      }) as unknown as http.ClientRequest;
      return clientReq;
    }) as unknown as typeof http.request;

    __setTestHttpRequestHooks({
      customTransport: mock500Transport,
      customDnsResolver: async (hostname: string) => {
        expect(hostname).toBe("incident-alerts.ops-monitor.com");
        // Resolves to an allowed public IPv4 address (e.g. 93.184.216.34) passing all SSRF checks
        return ["93.184.216.34"];
      },
    });

    try {
      const httpRes = await httpAction!.execute({
        workflowId: "wf_escalation",
        runId: "run_s3",
        stepId: "step_incident_webhook",
        inputs: {
          url: allowedPublicUrl,
          method: "POST",
          body: { incidentId: "inc_blocked_101", severity: "P1" },
        },
      });

      // HTTP step fails with genuine HTTP 500 status (exercising production non-success handling)
      expect(httpRes.success).toBe(false);
      expect(httpRes.error).toBe("HTTP request failed with status 500 (Internal Server Error)");
      expect(httpRes.isRetriable).toBe(true);

      // Separate security check: verify that metadata IP rejection is completely independent and unweakened
      const metadataRejection = await httpAction!.execute({
        workflowId: "wf_escalation",
        runId: "run_s3",
        stepId: "step_incident_webhook",
        inputs: {
          url: "http://169.254.169.254/latest/meta-data/",
          method: "POST",
        },
      });
      expect(metadataRejection.success).toBe(false);
      expect(metadataRejection.error).toContain("Security policy violation");
      expect(metadataRejection.isRetriable).toBe(false);
    } finally {
      __setTestHttpRequestHooks(null);
    }

    // =======================================================================
    // SAGA ROLLBACK TRIGGERED: Reverse-topological order
    // 1. Compensate Step 2: task.update (Reverts status to BLOCKED, priority to MEDIUM)
    // 2. Compensate Step 1: comment.create (Appends rollback tombstone note)
    // =======================================================================

    // 1. Compensate task.update
    expect(updateAction?.compensate).toBeDefined();
    const taskCompRes = await updateAction!.compensate!({
      workflowId: "wf_escalation",
      runId: "run_s3",
      stepId: "step_escalate_task",
      stepRunId: "sr_update_1",
      inputs: {},
      outputs: updateOutputs as JsonValue,
    });

    expect(taskCompRes.success).toBe(true);

    // Assert task status reverted to BLOCKED and priority to MEDIUM!
    const revertedTask = taskStore.get("task_blocked");
    expect(revertedTask?.status).toBe("BLOCKED");
    expect(revertedTask?.priority).toBe("MEDIUM");

    // 2. Compensate comment.create
    expect(commentAction?.compensate).toBeDefined();
    const commentCompRes = await commentAction!.compensate!({
      workflowId: "wf_escalation",
      runId: "run_s3",
      stepId: "step_audit_comment",
      stepRunId: "sr_comment_1",
      inputs: {},
      outputs: commentOutputs as JsonValue,
    });

    expect(commentCompRes.success).toBe(true);

    // Assert original comment is retained AND tombstone note is appended
    const finalComment = commentStore.get(commentOutputs.commentId as string);
    expect(finalComment).toBeDefined();
    expect(finalComment?.content).toContain("Automated escalation initiated to incident paging system.");
    expect(finalComment?.content).toContain("[ROLLED BACK: Automated action rolled back due to downstream workflow failure]");

    // Verify audit logs persisted for both compensations
    expect(auditLogStore.some((a) => a.eventType === "COMPENSATION_TASK_UPDATED")).toBe(true);
    expect(auditLogStore.some((a) => a.eventType === "COMPENSATION_COMMENT_TOMBSTONED")).toBe(true);
  });
});
