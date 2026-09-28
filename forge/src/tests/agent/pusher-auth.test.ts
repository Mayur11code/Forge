// src/tests/agent/pusher-auth.test.ts
//
// Authorization contract for /api/pusher/auth.
//
// Regression target: the endpoint previously signed a channel signature for
// any request, with no auth and no ownership check, so any caller could
// subscribe to any other user's agent stream by guessing a session id.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: {
    authorizeChannel: jest.fn(),
  },
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
}));

import { NextRequest } from "next/server";

import { auth } from "@/lib/auth/auth";
import { pusherServer } from "@/lib/pusher/pusher-server";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { POST } from "@/app/api/pusher/auth/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const getSessionMock =
  getAgentSessionForUser as jest.MockedFunction<
    typeof getAgentSessionForUser
  >;
const authorizeMock =
  pusherServer.authorizeChannel as unknown as jest.Mock;

const SESSION_ID = "clx1234567890abcdefghijkl";
const OTHER_SESSION_ID = "clxzzzzzzzzzzzzzzzzzzzzzz";
const CHANNEL = `private-agent-${SESSION_ID}`;

function request(body: string) {
  return new NextRequest("http://localhost/api/pusher/auth", {
    method: "POST",
    body,
  });
}

function signedInAs(userId: string) {
  authMock.mockResolvedValue({ user: { id: userId } } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  authorizeMock.mockReturnValue({ auth: "signature" });
});

describe("unauthenticated", () => {
  it("rejects when there is no session", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await POST(
      request(`socket_id=1.1&channel_name=${CHANNEL}`),
    );

    expect(res.status).toBe(401);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("rejects when the session has no user id", async () => {
    authMock.mockResolvedValue({ user: {} } as never);

    const res = await POST(
      request(`socket_id=1.1&channel_name=${CHANNEL}`),
    );

    expect(res.status).toBe(401);
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});

describe("malformed requests", () => {
  it("rejects a body without channel_name", async () => {
    signedInAs("user_a");

    const res = await POST(request("socket_id=1.1"));

    expect(res.status).toBe(400);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    signedInAs("user_a");

    const res = await POST(request(""));

    expect(res.status).toBe(400);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("rejects a non-agent private channel", async () => {
    signedInAs("user_a");

    const res = await POST(
      request("socket_id=1.1&channel_name=private-presence-chat"),
    );

    expect(res.status).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("rejects a public channel", async () => {
    signedInAs("user_a");

    const res = await POST(
      request(`socket_id=1.1&channel_name=agent-${SESSION_ID}`),
    );

    expect(res.status).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("rejects a lookalike prefix", async () => {
    signedInAs("user_a");

    const res = await POST(
      request(`socket_id=1.1&channel_name=private-agentevil-${SESSION_ID}`),
    );

    expect(res.status).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("refuses a session owned by another user", async () => {
    signedInAs("user_a");
    // Session exists, but belongs to user_b: the owner-scoped lookup returns
    // nothing because the predicate includes userId.
    getSessionMock.mockResolvedValue(null);

    const res = await POST(
      request(`socket_id=1.1&channel_name=${CHANNEL}`),
    );

    expect(res.status).toBe(403);
    expect(getSessionMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: "user_a",
    });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    signedInAs("user_a");
    getSessionMock.mockResolvedValue(null);

    const res = await POST(
      request(`socket_id=1.1&channel_name=private-agent-${OTHER_SESSION_ID}`),
    );

    expect(res.status).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("authorizes the correct owner", async () => {
    signedInAs("user_a");
    getSessionMock.mockResolvedValue({
      id: SESSION_ID,
      orgId: "org_1",
      userId: "user_a",
    } as never);

    const res = await POST(
      request(`socket_id=1.1&channel_name=${CHANNEL}`),
    );

    expect(res.status).toBe(200);
    expect(getSessionMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: "user_a",
    });
    expect(authorizeMock).toHaveBeenCalledWith("1.1", CHANNEL);
    await expect(res.json()).resolves.toEqual({ auth: "signature" });
  });
});
