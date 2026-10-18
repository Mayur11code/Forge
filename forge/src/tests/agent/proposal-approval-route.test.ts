// src/tests/agent/proposal-approval-route.test.ts
//
// Assignment 37.9 — route-level coverage for the two proposal decision ingresses:
//   POST /api/agent/session/[sessionId]/proposal-approval
//   POST /api/agent/session/[sessionId]/proposal-decline
//
// The subject is the REAL HTTP handler: authentication, the strict closed Zod
// body contract, the untrusted-body boundary, and the mapping from the service's
// structured result to an HTTP status. The service is replaced with a double so
// every result code can be fed in deterministically; its own read-decide-write
// behaviour is covered by proposal-decision.test.ts.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/ai/agent/services/proposal-decision-service", () => ({
  submitProposalDecision: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";
import { POST as approve } from "@/app/api/agent/session/[sessionId]/proposal-approval/route";
import { POST as decline } from "@/app/api/agent/session/[sessionId]/proposal-decline/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const submitMock = submitProposalDecision as jest.MockedFunction<
  typeof submitProposalDecision
>;

const SESSION_ID = "clxsessionrouteaaaaaaaa";
const INTERACTION_ID = "clxexecroutebbbbbbbbbb";

type Body = Record<string, unknown>;

function post(
  handler: typeof approve,
  sessionId: string,
  body: Body | string,
) {
  return handler(
    new Request(
      `http://localhost/api/agent/session/${sessionId}/proposal-approval`,
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
    state: "APPROVED",
  } as never);
});

describe.each([
  ["proposal-approval", approve, "APPROVED"],
  ["proposal-decline", decline, "DECLINED"],
] as const)("%s", (_name, handler, decision) => {
  describe("authentication", () => {
    it("rejects an unauthenticated request with 401 and never reaches the service", async () => {
      authMock.mockResolvedValue(null as never);

      const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  describe("request handling", () => {
    it("forwards the URL session id, the authenticated user, the interaction id and the decision", async () => {
      const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

      expect(res.status).toBe(200);
      expect(submitMock).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        userId: "user_1",
        interactionId: INTERACTION_ID,
        decision,
      });
    });

    it("does not trust a userId supplied in the body", async () => {
      const res = await post(handler, SESSION_ID, {
        interactionId: INTERACTION_ID,
        userId: "attacker",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("INVALID_REQUEST");
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("does not trust a proposal state smuggled into the body", async () => {
      const res = await post(handler, SESSION_ID, {
        interactionId: INTERACTION_ID,
        state: "APPROVED",
      });

      expect(res.status).toBe(400);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("rejects an empty session id", async () => {
      const res = await post(handler, "", { interactionId: INTERACTION_ID });

      expect(res.status).toBe(400);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("rejects malformed JSON with the established validation error", async () => {
      const res = await post(handler, SESSION_ID, "{ not json");

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Invalid request body",
        code: "INVALID_REQUEST",
      });
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("rejects a body missing interactionId", async () => {
      const res = await post(handler, SESSION_ID, {});

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("INVALID_REQUEST");
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("rejects an empty interactionId", async () => {
      const res = await post(handler, SESSION_ID, { interactionId: "" });

      expect(res.status).toBe(400);
      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  describe("service-result status mapping", () => {
    const cases: Array<[string, 400 | 404 | 409]> = [
      ["INTERACTION_NOT_FOUND", 404],
      ["NOT_A_PROPOSAL", 409],
      ["REVISION_MISMATCH", 409],
      ["NEEDS_CRITICALITY", 409],
      ["PROPOSAL_EXPIRED", 409],
      ["PROPOSAL_ALREADY_DECIDED", 409],
      ["PROPOSAL_NOT_AWAITING_APPROVAL", 409],
      ["PROPOSAL_NOT_APPLIED", 409],
      ["SESSION_NOT_RUNNING", 409],
      ["SESSION_BUSY", 409],
      ["INVALID_REQUEST", 400],
    ];

    it.each(cases)("maps %s to HTTP %i", async (code, httpStatus) => {
      submitMock.mockResolvedValueOnce({
        ok: false,
        httpStatus,
        code,
        error: "service detail",
      } as never);

      const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

      expect(res.status).toBe(httpStatus);
      expect(await res.json()).toEqual({ error: "service detail", code });
    });
  });

  describe("success responses", () => {
    it("returns 200 with the accepted submission shape", async () => {
      submitMock.mockResolvedValueOnce({
        ok: true,
        sessionId: SESSION_ID,
        step: 3,
        state: decision,
      } as never);

      const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessionId: SESSION_ID,
        step: 3,
        state: decision,
        status: "ACCEPTED",
      });
    });

    it("reports idempotent: true on an accepted repeat", async () => {
      submitMock.mockResolvedValueOnce({
        ok: true,
        sessionId: SESSION_ID,
        step: 3,
        state: decision,
        idempotent: true,
      } as never);

      const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessionId: SESSION_ID,
        step: 3,
        state: decision,
        status: "ACCEPTED",
        idempotent: true,
      });
    });
  });

  describe("unexpected failure", () => {
    it("answers 500 rather than leaking the exception", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      submitMock.mockRejectedValueOnce(new Error("boom"));

      try {
        const res = await post(handler, SESSION_ID, { interactionId: INTERACTION_ID });

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Internal Server Error" });
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
