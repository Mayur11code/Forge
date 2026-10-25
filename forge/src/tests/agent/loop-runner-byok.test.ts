// src/tests/agent/loop-runner-byok.test.ts
jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForWorker: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  getMessages: jest.fn(async () => []),
  createMessage: jest.fn(),
}));

jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return {
    ...actual,
    generateText: jest.fn().mockResolvedValue({
      text: "Workflow proposal generated successfully.",
      toolCalls: [],
      response: { messages: [] },
    }),
  };
});

const mockResolveOrganizationLanguageModel = jest.fn();
jest.mock("@/lib/ai/resolver", () => {
  const actual = jest.requireActual("@/lib/ai/resolver");
  return {
    ...actual,
    resolveOrganizationLanguageModel: (...args: unknown[]) =>
      mockResolveOrganizationLanguageModel(...args),
  };
});

import { runAgentLoop } from "@/lib/ai/agent/loop-runner";
import { getAgentSessionForWorker } from "@/lib/ai/agent/session-service";
import { AiResolverError } from "@/lib/ai/resolver";
import { CredentialPurpose } from "@prisma/client";
import { generateText } from "ai";

const getSessionMock = getAgentSessionForWorker as jest.MockedFunction<
  typeof getAgentSessionForWorker
>;
const generateTextMock = generateText as jest.MockedFunction<typeof generateText>;

describe("loop-runner BYOK policy enforcement", () => {
  const orgId = "org-loop-byok";
  const sessionId = "sess-loop-byok";

  beforeEach(() => {
    jest.clearAllMocks();

    getSessionMock.mockResolvedValue({
      id: sessionId,
      orgId,
      userId: "user-1",
      status: "RUNNING",
      currentStep: 1,
      promptVersion: "v6",
      finalResponse: null,
      terminalReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      organization: {
        id: orgId,
        name: "Acme Corp",
      },
    } as never);
  });

  it("uses active organization credential model when resolved", async () => {
    const mockModel = { modelId: "gemini-3.6-flash", provider: "tenant-google" };
    mockResolveOrganizationLanguageModel.mockResolvedValueOnce(mockModel);

    const result = await runAgentLoop(sessionId);

    expect(result.kind).toBe("COMPLETE");
    expect(mockResolveOrganizationLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ orgId })
    );
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModel,
      })
    );
  });

  it("uses platform model when policy explicitly permits platform fallback", async () => {
    const mockPlatformModel = { modelId: "gemini-3.6-flash", provider: "platform-google" };
    mockResolveOrganizationLanguageModel.mockResolvedValueOnce(mockPlatformModel);

    const result = await runAgentLoop(sessionId);

    expect(result.kind).toBe("COMPLETE");
    expect(mockResolveOrganizationLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ orgId })
    );
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockPlatformModel,
      })
    );
  });

  it("fails turn safely when organization credential is required but missing", async () => {
    mockResolveOrganizationLanguageModel.mockRejectedValueOnce(
      new AiResolverError(
        "ORGANIZATION_KEY_REQUIRED",
        "Organization has no configured AI generation key. Platform fallback denied.",
        orgId,
        CredentialPurpose.GENERATION
      )
    );

    const result = await runAgentLoop(sessionId);

    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") {
      expect(result.reason).toBe("ERROR");
      expect(result.message).toContain("ORGANIZATION_KEY_REQUIRED");
    }
    // Invariant: generateText is never called when resolver rejects
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("fails turn safely when credential is configured but not active (INVALID or REVOKED)", async () => {
    mockResolveOrganizationLanguageModel.mockRejectedValueOnce(
      new AiResolverError(
        "CREDENTIAL_NOT_ACTIVE",
        "Organization generation credential is in status 'REVOKED'.",
        orgId,
        CredentialPurpose.GENERATION
      )
    );

    const result = await runAgentLoop(sessionId);

    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") {
      expect(result.reason).toBe("ERROR");
      expect(result.message).toContain("CREDENTIAL_NOT_ACTIVE");
    }
    // Invariant: Never silently fall back to platform agentModel
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("fails turn safely when entitlement policy cannot be resolved", async () => {
    mockResolveOrganizationLanguageModel.mockRejectedValueOnce(
      new AiResolverError(
        "POLICY_UNRESOLVED",
        "Unresolved plan identifier. No authoritative mapping exists.",
        orgId,
        CredentialPurpose.GENERATION
      )
    );

    const result = await runAgentLoop(sessionId);

    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") {
      expect(result.reason).toBe("ERROR");
      expect(result.message).toContain("POLICY_UNRESOLVED");
    }
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
