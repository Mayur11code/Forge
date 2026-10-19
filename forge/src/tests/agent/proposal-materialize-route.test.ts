// src/tests/agent/proposal-materialize-route.test.ts
//
// Assignment 37.11 — route-level coverage for the materialization ingress:
//   POST /api/agent/session/[sessionId]/proposal-materialize
//
// The subject is the REAL HTTP handler: authentication, the strict closed Zod
// body contract, the untrusted-body boundary, and the mapping from the service's
// structured result to an HTTP status. The service is replaced with a double so
// every result code can be fed in deterministically; its own read-transition-write
// behaviour is covered by proposal-materialization.test.ts.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/ai/agent/services/proposal-materialization-service", () => ({
  materializeProposal: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";
import { POST } from "@/app/api/agent/session/[sessionId]/proposal-materialize/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const materializeMock = materializeProposal as jest.MockedFunction<
  typeof materializeProposal
>;

const SESSION_ID = "clxsessionmaterializeroutea";
const INTERACTION_ID = "clxexecmaterializerouteb";

type Body = Record<string, unknown> | string | null;

function post(sessionId: string, body: Body) {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };

  if (typeof body === "string") {
    init.body = body;
  } else if (body !== null) {
    init.body = JSON.stringify(body);
  }

  return POST(
    new Request(
      `http://localhost/api/agent/session/${sessionId}/proposal-materialize`,
      init,
    ),
    { params: Promise.resolve({ sessionId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user_1" } } as never);
  materializeMock.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    workflowId: "wf_1",
    state: "MATERIALIZED",
  } as never);
});

describe("authentication", () => {
  it("rejects an unauthenticated request with 401 and never reaches the service", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });

    expect(res.status).toBe(401);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("passes the authenticated user id, not a body value", async () => {
    await post(SESSION_ID, { interactionId: INTERACTION_ID });

    expect(materializeMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: "user_1",
      interactionId: INTERACTION_ID,
    });
  });
});

describe("body contract", () => {
  it("rejects a missing body with 400", async () => {
    const res = await post(SESSION_ID, null);

    expect(res.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await post(SESSION_ID, "{not json");

    expect(res.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("rejects a missing interactionId with 400", async () => {
    const res = await post(SESSION_ID, {});

    expect(res.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("rejects an empty interactionId with 400", async () => {
    const res = await post(SESSION_ID, { interactionId: "" });

    expect(res.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown extra field with 400 (strict body)", async () => {
    const res = await post(SESSION_ID, {
      interactionId: INTERACTION_ID,
      orgId: "org_smuggled",
    });

    expect(res.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied workflowId or graph with 400", async () => {
    const withWorkflow = await post(SESSION_ID, {
      interactionId: INTERACTION_ID,
      workflowId: "wf_client",
    });
    const withGraph = await post(SESSION_ID, {
      interactionId: INTERACTION_ID,
      uiNodes: [],
    });

    expect(withWorkflow.status).toBe(400);
    expect(withGraph.status).toBe(400);
    expect(materializeMock).not.toHaveBeenCalled();
  });
});

describe("result mapping", () => {
  it("returns 200 with the workflow id and state on success", async () => {
    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      sessionId: SESSION_ID,
      workflowId: "wf_1",
      state: "MATERIALIZED",
      status: "MATERIALIZED",
    });
  });

  it("surfaces idempotency when the service reports it", async () => {
    materializeMock.mockResolvedValue({
      ok: true,
      sessionId: SESSION_ID,
      workflowId: "wf_1",
      state: "MATERIALIZED",
      idempotent: true,
    } as never);

    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.idempotent).toBe(true);
  });

  it("omits idempotent on a first-time creation", async () => {
    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).not.toHaveProperty("idempotent");
  });

  it.each([
    [404, "INTERACTION_NOT_FOUND"],
    [409, "REVISION_MISMATCH"],
    [409, "PROPOSAL_NOT_APPROVED"],
    [409, "MATERIALIZED_WITHOUT_WORKFLOW"],
    [409, "SESSION_BUSY"],
  ])("maps a %s/%s service failure to that status", async (status, code) => {
    materializeMock.mockResolvedValue({
      ok: false,
      httpStatus: status,
      code,
      error: "nope",
    } as never);

    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(status);
    expect(json.code).toBe(code);
  });

  it("returns 500 when the service throws", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    materializeMock.mockRejectedValue(new Error("boom"));

    const res = await post(SESSION_ID, { interactionId: INTERACTION_ID });

    expect(res.status).toBe(500);
    consoleError.mockRestore();
  });
});
