// src/tests/security/pusher-channel-authorization.test.ts
//
// Comprehensive authorization contract tests for /api/pusher/auth across
// organization, workflow run, and agent session channels.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: {
    authorizeChannel: jest.fn(),
  },
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    membership: {
      findUnique: jest.fn(),
    },
    workflowRun: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
}));

import { NextRequest } from "next/server";
import { auth } from "@/lib/auth/auth";
import { pusherServer } from "@/lib/pusher/pusher-server";
import { db } from "@/lib/prisma/db";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { POST } from "@/app/api/pusher/auth/route";

const authMock = auth as jest.Mock;
const authorizeMock = pusherServer.authorizeChannel as unknown as jest.Mock;
const membershipFindUnique = db.membership.findUnique as jest.Mock;
const workflowRunFindFirst = db.workflowRun.findFirst as jest.Mock;
const getAgentSessionMock = getAgentSessionForUser as jest.Mock;

const USER_A = "user_alpha";
const ORG_A = "org_alpha";
const ORG_B = "org_beta";
const RUN_A = "run_alpha_123";
const RUN_B = "run_beta_456";
const SESSION_A = "session_alpha_789";

function makeRequest(socketId: string, channelName: string) {
  return new NextRequest("http://localhost/api/pusher/auth", {
    method: "POST",
    body: `socket_id=${socketId}&channel_name=${channelName}`,
  });
}

describe("POST /api/pusher/auth — Tenant Isolation & Channel Authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authorizeMock.mockReturnValue({ auth: "mocked_pusher_sig" });
  });

  describe("Authentication Barrier", () => {
    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      authMock.mockResolvedValueOnce(null);

      const res = await POST(makeRequest("1.1", `private-org-${ORG_A}`));
      expect(res.status).toBe(401);
      expect(authorizeMock).not.toHaveBeenCalled();
    });

    it("rejects requests when user id is missing from session", async () => {
      authMock.mockResolvedValueOnce({ user: {} });

      const res = await POST(makeRequest("1.1", `private-org-${ORG_A}`));
      expect(res.status).toBe(401);
      expect(authorizeMock).not.toHaveBeenCalled();
    });
  });

  describe("Organization Channel Authorization (private-org-*)", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: USER_A } });
    });

    it("authorizes verified members of the organization", async () => {
      membershipFindUnique.mockResolvedValueOnce({ id: "mem_123" });

      const channel = `private-org-${ORG_A}`;
      const res = await POST(makeRequest("1.1", channel));

      expect(res.status).toBe(200);
      expect(membershipFindUnique).toHaveBeenCalledWith({
        where: {
          userId_orgId: {
            userId: USER_A,
            orgId: ORG_A,
          },
        },
        select: { id: true },
      });
      expect(authorizeMock).toHaveBeenCalledWith("1.1", channel);
      await expect(res.json()).resolves.toEqual({ auth: "mocked_pusher_sig" });
    });

    it("rejects non-members attempting to subscribe to another organization's stream (IDOR)", async () => {
      // User A is not a member of Org B
      membershipFindUnique.mockResolvedValueOnce(null);

      const channel = `private-org-${ORG_B}`;
      const res = await POST(makeRequest("1.1", channel));

      expect(res.status).toBe(403);
      expect(membershipFindUnique).toHaveBeenCalledWith({
        where: {
          userId_orgId: {
            userId: USER_A,
            orgId: ORG_B,
          },
        },
        select: { id: true },
      });
      expect(authorizeMock).not.toHaveBeenCalled();
    });

    it("rejects malformed or empty organization channel names", async () => {
      const res1 = await POST(makeRequest("1.1", "private-org-"));
      expect(res1.status).toBe(403);

      const res2 = await POST(makeRequest("1.1", "private-org-invalid$$chars"));
      expect(res2.status).toBe(403);
      expect(membershipFindUnique).not.toHaveBeenCalled();
    });
  });

  describe("Workflow Run Channel Authorization (private-workflow-*)", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: USER_A } });
    });

    it("authorizes members of the organization that owns the workflow run", async () => {
      workflowRunFindFirst.mockResolvedValueOnce({ id: RUN_A });

      const channel = `private-workflow-${RUN_A}`;
      const res = await POST(makeRequest("2.2", channel));

      expect(res.status).toBe(200);
      expect(workflowRunFindFirst).toHaveBeenCalledWith({
        where: {
          id: RUN_A,
          workflow: {
            organization: {
              memberships: {
                some: { userId: USER_A },
              },
            },
          },
        },
        select: { id: true },
      });
      expect(authorizeMock).toHaveBeenCalledWith("2.2", channel);
      await expect(res.json()).resolves.toEqual({ auth: "mocked_pusher_sig" });
    });

    it("rejects cross-tenant workflow run subscription attempts (IDOR)", async () => {
      // Run B exists in Org B, but User A is not a member of Org B
      workflowRunFindFirst.mockResolvedValueOnce(null);

      const channel = `private-workflow-${RUN_B}`;
      const res = await POST(makeRequest("2.2", channel));

      expect(res.status).toBe(403);
      expect(workflowRunFindFirst).toHaveBeenCalledWith({
        where: {
          id: RUN_B,
          workflow: {
            organization: {
              memberships: {
                some: { userId: USER_A },
              },
            },
          },
        },
        select: { id: true },
      });
      expect(authorizeMock).not.toHaveBeenCalled();
    });

    it("rejects subscription attempts for nonexistent workflow runs", async () => {
      workflowRunFindFirst.mockResolvedValueOnce(null);

      const channel = "private-workflow-nonexistent_run_id";
      const res = await POST(makeRequest("2.2", channel));

      expect(res.status).toBe(403);
      expect(authorizeMock).not.toHaveBeenCalled();
    });

    it("rejects malformed workflow channel names", async () => {
      const res = await POST(makeRequest("2.2", "private-workflow-"));
      expect(res.status).toBe(403);
      expect(workflowRunFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("Agent Session Channel Authorization (private-agent-*)", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: USER_A } });
    });

    it("authorizes the authenticated owner of the agent session", async () => {
      getAgentSessionMock.mockResolvedValueOnce({
        id: SESSION_A,
        userId: USER_A,
        orgId: ORG_A,
      });

      const channel = `private-agent-${SESSION_A}`;
      const res = await POST(makeRequest("3.3", channel));

      expect(res.status).toBe(200);
      expect(getAgentSessionMock).toHaveBeenCalledWith({
        sessionId: SESSION_A,
        userId: USER_A,
      });
      expect(authorizeMock).toHaveBeenCalledWith("3.3", channel);
    });

    it("rejects attempts to access another user's agent session", async () => {
      getAgentSessionMock.mockResolvedValueOnce(null);

      const channel = "private-agent-other_users_session";
      const res = await POST(makeRequest("3.3", channel));

      expect(res.status).toBe(403);
      expect(authorizeMock).not.toHaveBeenCalled();
    });
  });

  describe("Unauthorizable Channels", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: USER_A } });
    });

    it("rejects public channel names", async () => {
      const res = await POST(makeRequest("1.1", `org-${ORG_A}`));
      expect(res.status).toBe(403);
      expect(authorizeMock).not.toHaveBeenCalled();
    });

    it("rejects unsupported private channel prefixes", async () => {
      const res = await POST(makeRequest("1.1", "private-chat-room1"));
      expect(res.status).toBe(403);
      expect(authorizeMock).not.toHaveBeenCalled();
    });
  });
});
