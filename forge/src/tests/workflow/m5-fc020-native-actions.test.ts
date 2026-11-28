// src/tests/workflow/m5-fc020-native-actions.test.ts
//
// M5 FC-020: Native Action Reconciliation and Registration Test Suite.
// Verifies:
// 1. `email.send@1.0.0` execution, input validation, HTML escaping, and error handling.
// 2. `report.generate@1.0.0` structured Markdown generation with real metrics and UploadThing compensation.
// 3. `logic.condition@1.0.0` operator evaluations, branch output, and error handling.
// 4. Exact version lookup in ActionRegistry.

jest.mock("server-only", () => ({}));

const mockSendEmail = jest.fn();
jest.mock("@/lib/emails/core-service", () => ({
  executeSendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockUploadFiles = jest.fn();
const mockDeleteFiles = jest.fn();
jest.mock("@/lib/uploadThing/uploadthing-server", () => ({
  utapi: {
    uploadFiles: (...args: unknown[]) => mockUploadFiles(...args),
    deleteFiles: (...args: unknown[]) => mockDeleteFiles(...args),
  },
}));

const mockTasks = [
  { id: "task_1", title: "Task 1", status: "TODO", priority: "HIGH", createdAt: new Date(), assignee: { name: "Alice", email: "alice@example.com" }, project: { name: "P1" } },
  { id: "task_2", title: "Task 2", status: "IN_PROGRESS", priority: "MEDIUM", createdAt: new Date(), assignee: { name: "Bob", email: "bob@example.com" }, project: { name: "P1" } },
  { id: "task_3", title: "Task 3", status: "DONE", priority: "LOW", createdAt: new Date(), assignee: null, project: { name: "P1" } },
  { id: "task_4", title: "Task 4", status: "BLOCKED", priority: "HIGH", createdAt: new Date(), assignee: { name: "Alice", email: "alice@example.com" }, project: { name: "P1" } },
];

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: {
      findUnique: jest.fn().mockResolvedValue({ id: "wf_1", orgId: "org_test", name: "Alpha Workflow" }),
    },
    task: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockTasks)),
    },
  },
}));

import { sendEmailAction } from "@/lib/workflow/actions/core/send-email";
import { generateReportAction } from "@/lib/workflow/actions/core/generate-report";
import { conditionAction } from "@/lib/workflow/actions/logic/conditions";
import { ActionRegistry, getAction } from "@/lib/workflow-types/action-registry";

describe("M5 FC-020: Native Actions Registration & Execution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("email.send@1.0.0", () => {
    it("is registered with canonical identity in ActionRegistry", () => {
      expect(ActionRegistry["email.send"]).toBeDefined();
      expect(sendEmailAction.id).toBe("email.send");
      expect(sendEmailAction.version).toBe("1.0.0");
      expect(getAction("email.send", "1.0.0")).toBe(sendEmailAction);
    });

    it("requires toEmail and subject", async () => {
      const res = await sendEmailAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: { toEmail: "test@example.com" }, // missing subject
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Missing required fields");
      expect(res.isRetriable).toBe(false);
    });

    it("escapes HTML in subject and bodyText to prevent injection", async () => {
      mockSendEmail.mockResolvedValueOnce({ id: "resend_msg_123", deliveredTo: "dev@example.com" });

      const res = await sendEmailAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: {
          toEmail: "dev@example.com",
          subject: "<script>alert('xss')</script> Clean Subject",
          bodyText: "Hello <b>World</b> & friends",
        },
      });

      expect(res.success).toBe(true);
      expect(res.data).toEqual({
        resendId: "resend_msg_123",
        messageId: "resend_msg_123",
        deliveredTo: "dev@example.com",
      });

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const callArg = mockSendEmail.mock.calls[0][0];
      expect(callArg.html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt; Clean Subject");
      expect(callArg.html).toContain("Hello &lt;b&gt;World&lt;/b&gt; &amp; friends");
    });

    it("handles validation_error as non-retriable", async () => {
      const err = new Error("Invalid email domain");
      (err as unknown as { name: string }).name = "validation_error";
      mockSendEmail.mockRejectedValueOnce(err);

      const res = await sendEmailAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: { toEmail: "bad@domain", subject: "Test" },
      });

      expect(res.success).toBe(false);
      expect(res.isRetriable).toBe(false);
    });
  });

  describe("report.generate@1.0.0", () => {
    it("is registered with canonical identity in ActionRegistry", () => {
      expect(ActionRegistry["report.generate"]).toBeDefined();
      expect(generateReportAction.id).toBe("report.generate");
      expect(generateReportAction.version).toBe("1.0.0");
      expect(getAction("report.generate", "1.0.0")).toBe(generateReportAction);
    });

    it("generates a real structured Markdown report with metrics and uploads to UploadThing", async () => {
      mockUploadFiles.mockResolvedValueOnce({
        data: {
          url: "https://utfs.io/f/report-123.md",
          key: "ut_file_key_123",
          name: "report-alpha-workflow.md",
          size: 1540,
        },
      });

      const res = await generateReportAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: {
          title: "Q4 Project Audit",
          userName: "Alice Lead",
        },
      });

      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
      const data = res.data as Record<string, unknown>;
      expect(data.documentUrl).toBe("https://utfs.io/f/report-123.md");
      expect(data.fileKey).toBe("ut_file_key_123");
      expect(data.fileName).toBe("report-alpha-workflow.md");
      expect(data.sizeBytes).toBe(1540);

      // Verify the generated Markdown content contains real structured metrics
      const md = data.markdownContent as string;
      expect(md).toContain("# Q4 Project Audit");
      expect(md).toContain("Total Tasks | 4 | 100%");
      expect(md).toContain("Completed (DONE) | 1 | 25%");
      expect(md).toContain("In Progress | 1 | 25%");
      expect(md).toContain("Blocked | 1 | 25%");
      expect(md).toContain("Todo | 1 | 25%");
      expect(md).toContain("HIGH | 2");
      expect(md).toContain("MEDIUM | 1");
      expect(md).toContain("LOW | 1");
      expect(md).toContain("Alice Lead");

      // Verify file upload was called with a markdown File
      expect(mockUploadFiles).toHaveBeenCalledTimes(1);
      const fileArg = mockUploadFiles.mock.calls[0][0];
      expect(fileArg.type).toBe("text/markdown");
    });

    it("compensates by deleting the exact artifact using the historical fileKey", async () => {
      mockDeleteFiles.mockResolvedValueOnce({ success: true });

      expect(generateReportAction.compensate).toBeDefined();
      const compRes = await generateReportAction.compensate!({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: {},
        outputs: {
          fileKey: "ut_file_key_123",
          documentUrl: "https://utfs.io/f/report-123.md",
        },
      });

      expect(compRes.success).toBe(true);
      expect(mockDeleteFiles).toHaveBeenCalledWith("ut_file_key_123");
    });
  });

  describe("logic.condition@1.0.0", () => {
    it("is registered with canonical identity in ActionRegistry", () => {
      expect(ActionRegistry["logic.condition"]).toBeDefined();
      expect(conditionAction.id).toBe("logic.condition");
      expect(conditionAction.version).toBe("1.0.0");
      expect(getAction("logic.condition", "1.0.0")).toBe(conditionAction);
    });

    it("evaluates comparisons accurately", async () => {
      const testCases = [
        { v1: 100, op: ">", v2: 50, expectedBranch: "TRUE" },
        { v1: 20, op: ">", v2: 50, expectedBranch: "FALSE" },
        { v1: "URGENT", op: "==", v2: "URGENT", expectedBranch: "TRUE" },
        { v1: "URGENT", op: "!==", v2: "LOW", expectedBranch: "TRUE" },
        { v1: "Database leak", op: "CONTAINS", v2: "leak", expectedBranch: "TRUE" },
        { v1: "Database leak", op: "CONTAINS", v2: "security", expectedBranch: "FALSE" },
      ];

      for (const tc of testCases) {
        const res = await conditionAction.execute({
          workflowId: "wf_1",
          runId: "run_1",
          stepId: "step_1",
          inputs: { value1: tc.v1, operator: tc.op, value2: tc.v2 },
        });

        expect(res.success).toBe(true);
        expect((res.data as Record<string, unknown>).branch).toBe(tc.expectedBranch);
      }
    });

    it("rejects unsupported operators cleanly", async () => {
      const res = await conditionAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_1",
        inputs: { value1: 1, operator: "UNKNOWN_OP", value2: 2 },
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Unsupported operator");
      expect(res.isRetriable).toBe(false);
    });
  });
});
