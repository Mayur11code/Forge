// src/tests/security/stream-audit-authz.test.ts
jest.mock("server-only", () => ({}));

const mockAuth = jest.fn();
jest.mock("@/lib/auth/auth", () => ({
  auth: () => mockAuth(),
}));

const mockMembershipFindUnique = jest.fn();
const mockMembershipFindFirst = jest.fn();
jest.mock("@/lib/prisma/db", () => ({
  db: {
    membership: {
      findUnique: (...args: unknown[]) => mockMembershipFindUnique(...args),
      findFirst: (...args: unknown[]) => mockMembershipFindFirst(...args),
    },
  },
}));

const mockResolveOrganizationLanguageModel = jest.fn();
jest.mock("@/lib/ai/resolver", () => {
  const actual = jest.requireActual("@/lib/ai/resolver");
  return {
    ...actual,
    resolveOrganizationLanguageModel: (...args: unknown[]) =>
      mockResolveOrganizationLanguageModel(...args),
  };
});

const mockStreamText = jest.fn().mockReturnValue({
  toTextStreamResponse: jest.fn().mockReturnValue(new Response("streamed-response")),
});
jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
  };
});

import { POST } from "@/app/api/stream-audit/route";
import { AiResolverError } from "@/lib/ai/resolver";
import { CredentialPurpose } from "@prisma/client";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/stream-audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/stream-audit Authorization & Tenant Gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects unauthenticated caller with 401", async () => {
    mockAuth.mockResolvedValueOnce(null);

    const res = await POST(jsonRequest({ rawCodePayload: "const x = 1;" }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized.");
    expect(mockResolveOrganizationLanguageModel).not.toHaveBeenCalled();
  });

  it("rejects missing rawCodePayload with 400", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "user-1" } });

    const res = await POST(jsonRequest({ rawCodePayload: "   " }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("rawCodePayload is required.");
  });

  it("rejects forged orgId with 403 when user is not a member of the requested org", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "attacker-user-id" } });
    mockMembershipFindUnique.mockResolvedValueOnce(null); // not a member

    const res = await POST(
      jsonRequest({
        rawCodePayload: "const x = 1;",
        orgId: "victim-org-uuid",
      })
    );

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Forbidden");
    expect(mockMembershipFindUnique).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: "attacker-user-id",
          orgId: "victim-org-uuid",
        },
      },
    });
    expect(mockResolveOrganizationLanguageModel).not.toHaveBeenCalled();
  });

  it("rejects request with 403 if orgId is omitted and user belongs to no orgs", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "homeless-user-id" } });
    mockMembershipFindFirst.mockResolvedValueOnce(null);

    const res = await POST(
      jsonRequest({
        rawCodePayload: "const x = 1;",
      })
    );

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Forbidden: User does not belong to any organization.");
    expect(mockResolveOrganizationLanguageModel).not.toHaveBeenCalled();
  });

  it("allows authorized member to stream audit using resolved organization model", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "legit-user-id" } });
    mockMembershipFindUnique.mockResolvedValueOnce({
      id: "membership-1",
      userId: "legit-user-id",
      orgId: "my-org-id",
      role: "MEMBER",
    });

    const mockResolvedModel = { modelId: "gemini-3.6-flash" };
    mockResolveOrganizationLanguageModel.mockResolvedValueOnce(mockResolvedModel);

    const res = await POST(
      jsonRequest({
        rawCodePayload: "function evaluate() { return 42; }",
        orgId: "my-org-id",
      })
    );

    expect(res.status).toBe(200);
    expect(mockResolveOrganizationLanguageModel).toHaveBeenCalledWith({ orgId: "my-org-id" });
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockResolvedModel,
      })
    );
  });

  it("returns 402 Payment Required when organization has no key and fallback is denied", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "legit-user-id" } });
    mockMembershipFindUnique.mockResolvedValueOnce({
      id: "membership-1",
      userId: "legit-user-id",
      orgId: "free-org-id",
      role: "MEMBER",
    });

    mockResolveOrganizationLanguageModel.mockRejectedValueOnce(
      new AiResolverError(
        "ORGANIZATION_KEY_REQUIRED",
        "Organization has no configured AI generation key. Platform fallback denied.",
        "free-org-id",
        CredentialPurpose.GENERATION
      )
    );

    const res = await POST(
      jsonRequest({
        rawCodePayload: "const x = 1;",
        orgId: "free-org-id",
      })
    );

    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.code).toBe("ORGANIZATION_KEY_REQUIRED");
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});
