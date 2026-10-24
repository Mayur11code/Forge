// src/tests/security/rate-limit-routes.test.ts
//
// Route-level and Action-level integration tests for H3 rate limiting & AI admission control.
// Proves that rejected requests cannot execute the protected operations, that trusted server-derived
// identities are passed, and that fail-closed behavior is verified at the route/action boundary.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: { findFirst: jest.fn() },
  },
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    project: { findFirst: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}));

jest.mock("@/lib/tasks/create-task", () => ({
  createTaskInOrg: jest.fn(),
}));

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("@/lib/ai/agent/orchestrator", () => ({
  startAgentSession: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("@/lib/security/rate-limit", () => {
  const actual = jest.requireActual("@/lib/security/rate-limit");
  return {
    ...actual,
    checkRateLimit: jest.fn(),
    getRateLimitStatus: jest.fn(),
  };
});

import { auth } from "@/lib/auth/auth";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { db } from "@/lib/prisma/db";
import { prisma } from "@/lib/prisma/extended";
import { createTaskInOrg } from "@/lib/tasks/create-task";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { startAgentSession } from "@/lib/ai/agent/orchestrator";
import {
  checkRateLimit,
  getRateLimitStatus,
  RATE_LIMIT_POLICIES,
} from "@/lib/security/rate-limit";

import { createTask } from "@/app/actions/Tasks/createTask";
import { POST as postTestRun } from "@/app/api/workflow/test/[workflowId]/test-run/route";
import { POST as postAgentInit } from "@/app/api/agent/init/route";
import { GET as getRateLimitStatusRoute } from "@/app/api/agent/rate-limit/route";

const authMock = auth as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;
const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const projectFindFirst = prisma.project.findFirst as jest.Mock;
const orgFindUnique = prisma.organization.findUnique as jest.Mock;
const createTaskInOrgMock = createTaskInOrg as jest.Mock;
const startWorkflowMock = startWorkflow as jest.Mock;
const startAgentSessionMock = startAgentSession as jest.Mock;
const checkRateLimitMock = checkRateLimit as jest.Mock;
const getRateLimitStatusMock = getRateLimitStatus as jest.Mock;

describe("H3 Route & Action Boundary Verification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Task Creation Enforcement (createTask Server Action)", () => {
    const validTaskInput = {
      title: "Production Hardening Task",
      projectId: "clxyz0000000000000000000a",
      priority: "HIGH",
    };

    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: "user_author" } });
      projectFindFirst.mockResolvedValue({ id: "clxyz0000000000000000000a", orgId: "org_alpha" });
      orgFindUnique.mockResolvedValue({ id: "org_alpha", slug: "alpha-corp" });
      getOrgAccessMock.mockResolvedValue({
        userId: "user_author",
        organization: { id: "org_alpha", slug: "alpha-corp" },
      });
      createTaskInOrgMock.mockResolvedValue({
        success: true,
        task: { id: "task_1", title: "Production Hardening Task" },
      });
    });

    it("blocks task creation when user rate limit is exceeded and never reaches database", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: false,
        status: 429,
        error: "RATE_LIMITED",
        message: "Too many requests. Please wait before retrying.",
        limit: 10,
        remaining: 0,
        reset: Date.now() + 10000,
        retryAfterSeconds: 10,
        headers: { "Retry-After": "10" },
      });

      const result = await createTask(validTaskInput);

      expect(checkRateLimitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: RATE_LIMIT_POLICIES.REQUEST_TASK_CREATE,
          userId: "user_author",
          orgId: "org_alpha",
        })
      );

      expect(result).toEqual({
        success: false,
        error: "RATE_LIMIT",
        message: "Too many requests. Please wait before retrying.",
        remaining: 0,
        reset: expect.any(Number),
      });

      // Crucial security invariant: rejected request MUST NOT write to database
      expect(createTaskInOrgMock).not.toHaveBeenCalled();
    });

    it("blocks task creation when organization rate limit is exceeded", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: false,
        status: 429,
        error: "RATE_LIMITED",
        message: "Organization request limit exceeded.",
        limit: 100,
        remaining: 0,
        reset: Date.now() + 30000,
        retryAfterSeconds: 30,
        headers: { "Retry-After": "30" },
      });

      const result = await createTask(validTaskInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe("RATE_LIMIT");
      expect(createTaskInOrgMock).not.toHaveBeenCalled();
    });

    it("permits task creation when rate limit check succeeds", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: true,
        status: 200,
        limit: 10,
        remaining: 8,
        reset: Date.now() + 10000,
        headers: {},
      });

      const result = await createTask(validTaskInput);

      expect(result.success).toBe(true);
      expect(createTaskInOrgMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Production Hardening Task" }),
        { orgId: "org_alpha", userId: "user_author" }
      );
    });
  });

  describe("Workflow Test-Run Enforcement (POST /api/workflow/test/[workflowId]/test-run)", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: "user_runner" } });
      workflowFindFirst.mockResolvedValue({
        id: "wf_target",
        orgId: "org_target",
      });
      startWorkflowMock.mockResolvedValue({ id: "run_test_1" });
    });

    it("invokes REQUEST_WORKFLOW_TEST_RUN and rejects exceeded quota with 429", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: false,
        status: 429,
        error: "RATE_LIMITED",
        message: "Too many requests. Please wait before retrying.",
        limit: 5,
        remaining: 0,
        reset: Date.now() + 60000,
        retryAfterSeconds: 60,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "0",
        },
      });

      const req = new Request("http://localhost/api/workflow/test/wf_target/test-run", {
        method: "POST",
      });
      const res = await postTestRun(req, {
        params: Promise.resolve({ workflowId: "wf_target" }),
      });

      expect(checkRateLimitMock).toHaveBeenCalledWith({
        policy: RATE_LIMIT_POLICIES.REQUEST_WORKFLOW_TEST_RUN,
        userId: "user_runner",
        orgId: "org_target",
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");

      const body = await res.json();
      expect(body.error).toBe("RATE_LIMITED");

      // Critical invariant: startWorkflow must NEVER be called if rate-limited
      expect(startWorkflowMock).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when Redis is unavailable for REQUEST_WORKFLOW_TEST_RUN", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: false,
        status: 503,
        error: "RATE_LIMITER_UNAVAILABLE",
        message: "Rate limit verification temporarily unavailable. Please try again shortly.",
        limit: 0,
        remaining: 0,
        reset: Date.now() + 5000,
        retryAfterSeconds: 5,
        headers: { "Retry-After": "5" },
      });

      const req = new Request("http://localhost/api/workflow/test/wf_target/test-run", {
        method: "POST",
      });
      const res = await postTestRun(req, {
        params: Promise.resolve({ workflowId: "wf_target" }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(startWorkflowMock).not.toHaveBeenCalled();
    });

    it("permits test-run and returns 200 with headers when rate limit passes", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: true,
        status: 200,
        limit: 5,
        remaining: 4,
        reset: Date.now() + 60000,
        headers: {
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "4",
        },
      });

      const req = new Request("http://localhost/api/workflow/test/wf_target/test-run", {
        method: "POST",
      });
      const res = await postTestRun(req, {
        params: Promise.resolve({ workflowId: "wf_target" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
      expect(startWorkflowMock).toHaveBeenCalledWith("org_target", "wf_target", {
        projectId: "cmnj8u44p0003a0gcvqgt25dv",
      });
    });
  });

  describe("Agent Init Admission Enforcement (POST /api/agent/init)", () => {
    beforeEach(() => {
      getOrgAccessMock.mockResolvedValue({
        userId: "user_agent_caller",
        organization: { id: "org_agent", slug: "agent-org" },
      });
      startAgentSessionMock.mockResolvedValue({
        id: "sess_123",
        status: "RUNNING",
      });
    });

    it("rejects agent initiation with 429 when AI admission token bucket is exhausted", async () => {
      checkRateLimitMock.mockResolvedValueOnce({
        allowed: false,
        status: 429,
        error: "RATE_LIMITED",
        message: "AI admission rate limit reached. Please wait before starting another session.",
        limit: 5,
        remaining: 0,
        reset: Date.now() + 120000,
        retryAfterSeconds: 120,
        headers: { "Retry-After": "120" },
      });

      const req = new Request("http://localhost/api/agent/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug: "agent-org",
          message: "Create an onboarding workflow",
        }),
      });

      const res = await postAgentInit(req);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("120");
      // Session MUST NOT be started
      expect(startAgentSessionMock).not.toHaveBeenCalled();
    });
  });

  describe("Authenticated Read-Only Status Route (GET /api/agent/rate-limit)", () => {
    it("returns 401 Unauthorized when session is missing", async () => {
      authMock.mockResolvedValue(null);

      const req = new Request("http://localhost/api/agent/rate-limit?orgSlug=acme");
      const res = await getRateLimitStatusRoute(req);

      expect(res.status).toBe(401);
    });

    it("returns 403 Forbidden when caller is not a member of the organization", async () => {
      authMock.mockResolvedValue({ user: { id: "user_outsider" } });
      getOrgAccessMock.mockResolvedValue(null);

      const req = new Request("http://localhost/api/agent/rate-limit?orgSlug=private-org");
      const res = await getRateLimitStatusRoute(req);

      expect(res.status).toBe(403);
    });

    it("returns 200 with quota metadata without consuming tokens", async () => {
      authMock.mockResolvedValue({ user: { id: "user_member" } });
      getOrgAccessMock.mockResolvedValue({
        userId: "user_member",
        organization: { id: "org_member", slug: "member-org" },
      });

      getRateLimitStatusMock.mockResolvedValueOnce({
        available: true,
        limit: 5,
        remaining: 3,
        reset: Date.now() + 60000,
      });

      const req = new Request("http://localhost/api/agent/rate-limit?orgSlug=member-org&operation=agent_init");
      const res = await getRateLimitStatusRoute(req);

      expect(res.status).toBe(200);
      expect(getRateLimitStatusMock).toHaveBeenCalledWith({
        policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
        userId: "user_member",
        orgId: "org_member",
      });

      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.limit).toBe(5);
      expect(body.remaining).toBe(3);
    });
  });
});
