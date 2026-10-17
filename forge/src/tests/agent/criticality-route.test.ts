// src/tests/agent/criticality-route.test.ts
//
// Route-level coverage for POST /api/agent/session/[sessionId]/criticality.
//
// The subject is the REAL HTTP handler: authentication, the strict Zod request
// contract, the untrusted-body boundary, and the mapping from the service's
// structured result to an HTTP status. The service is replaced with a double so
// each result code can be fed in deterministically; its own read-decide-write
// behaviour is covered by criticality-service.test.ts.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/ai/agent/services/criticality-service", () => ({
  submitCriticalityDecision: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { submitCriticalityDecision } from "@/lib/ai/agent/services/criticality-service";
import { POST } from "@/app/api/agent/session/[sessionId]/criticality/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const submitMock = submitCriticalityDecision as jest.MockedFunction<
  typeof submitCriticalityDecision
>;

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const INTERACTION_ID = "clxexecbbbbbbbbbbbbbbbb";

type Body = Record<string, unknown>;

function validBody(overrides: Body = {}): Body {
  return {
    interactionId: INTERACTION_ID,
    decisions: { setup: true, notify: false },
    ...overrides,
  };
}

function post(sessionId: string, body: Body | string) {
  return POST(
    new Request(
      `http://localhost/api/agent/session/${sessionId}/criticality`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ sessionId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user_1" } } as never);
  submitMock.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    step: 3,
  });
});

describe("authentication", () => {
  it("rejects an unauthenticated request with 401 and never reaches the service", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe("request handling", () => {
  it("forwards the URL session id, the authenticated user and the decision set", async () => {
    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: "user_1",
      interactionId: INTERACTION_ID,
      decisions: { setup: true, notify: false },
    });
  });

  it("does not trust a userId supplied in the request body", async () => {
    const res = await post(SESSION_ID, validBody({ userId: "attacker" }));

    // The strict schema rejects the unknown key outright.
    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects an injected isCritical field with 400", async () => {
    const res = await post(SESSION_ID, validBody({ isCritical: true }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects an injected correlationId with 400", async () => {
    const res = await post(
      SESSION_ID,
      validBody({ correlationId: "prop_corr_1234567890abcdef" }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects an empty session id with 400", async () => {
    const res = await post("", validBody());

    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the established validation error", async () => {
    const res = await post(SESSION_ID, "{ not json");

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "Invalid request body",
      code: "INVALID_REQUEST",
    });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects a body missing interactionId", async () => {
    const res = await post(SESSION_ID, validBody({ interactionId: undefined }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects a decisions value that is not an object", async () => {
    const res = await post(SESSION_ID, validBody({ decisions: "nope" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean decision value", async () => {
    const res = await post(
      SESSION_ID,
      validBody({ decisions: { setup: "yes" } }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("passes empty decisions through so the service reports the contract error", async () => {
    submitMock.mockResolvedValueOnce({
      ok: false,
      httpStatus: 400,
      code: "INCOMPLETE_CRITICALITY",
      error: "No criticality decision was supplied for step \"setup\".",
    });

    const res = await post(SESSION_ID, validBody({ decisions: {} }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'No criticality decision was supplied for step "setup".',
      code: "INCOMPLETE_CRITICALITY",
    });
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: {} }),
    );
  });
});

describe("service-result status mapping", () => {
  const cases: Array<[string, 400 | 404 | 409]> = [
    ["INTERACTION_NOT_FOUND", 404],
    ["NOT_A_PROPOSAL", 409],
    ["STALE_CRITICALITY", 409],
    ["SESSION_NOT_RUNNING", 409],
    ["CRITICALITY_CONFLICT", 409],
    ["SESSION_BUSY", 409],
    ["UNKNOWN_CRITICALITY_STEP", 400],
    ["INCOMPLETE_CRITICALITY", 400],
    ["INVALID_CRITICALITY_VALUE", 400],
  ];

  it.each(cases)("maps %s to HTTP %i", async (code, httpStatus) => {
    submitMock.mockResolvedValueOnce({
      ok: false,
      httpStatus,
      code,
      error: "service detail",
    });

    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(httpStatus);
    expect(await res.json()).toEqual({ error: "service detail", code });
  });
});

describe("success responses", () => {
  it("returns 200 with the accepted submission shape", async () => {
    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      step: 3,
      status: "ACCEPTED",
    });
  });

  it("reports idempotent: true on an accepted repeat", async () => {
    submitMock.mockResolvedValueOnce({
      ok: true,
      sessionId: SESSION_ID,
      step: 3,
      idempotent: true,
    });

    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      step: 3,
      status: "ACCEPTED",
      idempotent: true,
    });
  });
});
