// src/tests/agent/clarification-route.test.ts
//
// Route-level coverage for POST /api/agent/session/[sessionId]/clarification.
//
// The subject here is the REAL HTTP handler: authentication, the Zod request
// contract, the untrusted-body boundary, and the mapping from the clarification
// service's structured result to an HTTP status. The service itself is replaced
// with a double so each result code can be fed in deterministically; the
// service's own read-decide-write behaviour is covered by
// missing-input-protocol.test.ts and by the connected continuation test.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/ai/agent/services/clarification-service", () => ({
  submitClarificationAnswer: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { submitClarificationAnswer } from "@/lib/ai/agent/services/clarification-service";
import { POST } from "@/app/api/agent/session/[sessionId]/clarification/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const submitMock = submitClarificationAnswer as jest.MockedFunction<
  typeof submitClarificationAnswer
>;

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const INTERACTION_ID = "clxexecbbbbbbbbbbbbbbbb";

type Body = Record<string, unknown>;

function validBody(overrides: Body = {}): Body {
  return {
    interactionId: INTERACTION_ID,
    correlationId: "prop_corr_1234567890abcdef",
    answers: { "steps.step1.inputs.projectId": "clxyz0000000000000000000a" },
    ...overrides,
  };
}

function post(sessionId: string, body: Body | string) {
  return POST(
    new Request(`http://localhost/api/agent/session/${sessionId}/clarification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user_1" } } as never);
  submitMock.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    step: 2,
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
  it("forwards the URL session id and the authenticated user to the service", async () => {
    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: "prop_corr_1234567890abcdef",
      answers: {
        "steps.step1.inputs.projectId": "clxyz0000000000000000000a",
      },
    });
  });

  it("does not trust a userId supplied in the request body", async () => {
    await post(SESSION_ID, validBody({ userId: "attacker" }));

    const args = submitMock.mock.calls[0][0];
    expect(args.userId).toBe("user_1");
    expect(args.userId).not.toBe("attacker");
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
    const res = await post(
      SESSION_ID,
      validBody({ interactionId: undefined }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects a body missing correlationId", async () => {
    const res = await post(
      SESSION_ID,
      validBody({ correlationId: undefined }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("rejects an answers value that is not an object", async () => {
    const res = await post(SESSION_ID, validBody({ answers: "nope" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("passes empty answers through so the service reports the contract error", async () => {
    submitMock.mockResolvedValueOnce({
      ok: false,
      httpStatus: 400,
      code: "EMPTY_ANSWERS",
      error: "At least one answer must be supplied.",
    });

    const res = await post(SESSION_ID, validBody({ answers: {} }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "At least one answer must be supplied.",
      code: "EMPTY_ANSWERS",
    });
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ answers: {} }),
    );
  });
});

describe("service-result status mapping", () => {
  const cases: Array<[string, 400 | 403 | 404 | 409, number]> = [
    ["NOT_FOUND", 404, 404],
    ["SESSION_NOT_RUNNING", 409, 409],
    ["INVALID_CORRELATION_ID", 400, 400],
    ["INVALID_INTERACTION_ID", 400, 400],
    ["EMPTY_ANSWERS", 400, 400],
    ["INVALID_ANSWER_VALUE", 400, 400],
    ["NO_PENDING_CLARIFICATION", 409, 409],
    ["STALE_CLARIFICATION", 409, 409],
    ["CLARIFICATION_CONFLICT", 409, 409],
    ["SESSION_BUSY", 409, 409],
  ];

  it.each(cases)(
    "maps %s to HTTP %i",
    async (code, serviceHttpStatus, expectedHttpStatus) => {
      submitMock.mockResolvedValueOnce({
        ok: false,
        httpStatus: serviceHttpStatus,
        code,
        error: "service detail",
      });

      const res = await post(SESSION_ID, validBody());

      expect(res.status).toBe(expectedHttpStatus);
      expect(await res.json()).toEqual({
        error: "service detail",
        code,
      });
    },
  );
});

describe("success responses", () => {
  it("returns 200 with the accepted submission shape", async () => {
    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      step: 2,
      status: "ACCEPTED",
    });
  });

  it("reports idempotent: true on an accepted repeat", async () => {
    submitMock.mockResolvedValueOnce({
      ok: true,
      sessionId: SESSION_ID,
      step: 2,
      idempotent: true,
    });

    const res = await post(SESSION_ID, validBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      step: 2,
      status: "ACCEPTED",
      idempotent: true,
    });
  });
});
