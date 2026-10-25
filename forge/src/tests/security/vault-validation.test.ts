// src/tests/security/vault-validation.test.ts
import { CredentialPurpose } from "@prisma/client";
import {
  validateGeminiKey,
  classifyGeminiValidationError,
  VALIDATION_MODELS,
} from "@/lib/security/vault/validation";

const mockGenerateContent = jest.fn();
const mockEmbedContent = jest.fn();

jest.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation((apiKey: string) => ({
      apiKey,
      getGenerativeModel: jest.fn().mockImplementation(({ model }: { model: string }) => ({
        model,
        generateContent: (...args: unknown[]) => mockGenerateContent(apiKey, model, ...args),
        embedContent: (...args: unknown[]) => mockEmbedContent(apiKey, model, ...args),
      })),
    })),
  };
});

describe("vault-validation: classifyGeminiValidationError", () => {
  it("classifies definitive Google authentication failures", () => {
    const error = Object.assign(
      new Error("API_KEY_INVALID: API key not valid. Please pass a valid API key."),
      { status: 400 }
    );

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("AUTH_FAILURE");
    expect(result.message).toContain("rejected by Google");
  });

  it("classifies quota and rate limit exhaustion", () => {
    const error = Object.assign(
      new Error("RESOURCE_EXHAUSTED: Rate limit exceeded"),
      { status: 429 }
    );

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("QUOTA_EXHAUSTED");
    expect(result.message).toContain("quota or rate limit exceeded");
  });

  it("classifies permission denial", () => {
    const error = Object.assign(
      new Error("PERMISSION_DENIED: Caller does not have required IAM permissions"),
      { status: 403 }
    );

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("PERMISSION_DENIED");
    expect(result.message).toContain("permission");
  });

  it("classifies transient 5xx server errors", () => {
    const error = Object.assign(
      new Error("503 Service Unavailable: Backends temporarily overloaded"),
      { status: 503 }
    );

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("TRANSIENT_FAILURE");
    expect(result.message).toContain("temporary server error");
  });

  it("classifies validation timeouts as transient failures", () => {
    const error = new Error("VALIDATION_TIMEOUT: Bounded check exceeded 5000ms");

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("TRANSIENT_FAILURE");
    expect(result.message).toContain("timed out");
  });

  it("redacts potential secret keys from error messages", () => {
    const leakedKey = "AIzaSyFakeSecretKeyForTesting123456789";
    const error = new Error(`Request failed for key ${leakedKey}`);

    const result = classifyGeminiValidationError(error);
    expect(result.message).not.toContain(leakedKey);
    expect(result.message).toContain("[REDACTED_GEMINI_KEY]");
  });

  it("classifies 404 or retired model as INVALID_REQUEST rather than AUTH_FAILURE", () => {
    const error = Object.assign(
      new Error("models/gemini-1.5-flash is not found for API version v1beta"),
      { status: 404 }
    );

    const result = classifyGeminiValidationError(error);
    expect(result.category).toBe("INVALID_REQUEST");
    expect(result.message).toContain("retired or not found");
  });
});

describe("vault-validation: validateGeminiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects empty or whitespace-only keys without making network calls", async () => {
    const result = await validateGeminiKey({
      apiKey: "   ",
      purpose: CredentialPurpose.GENERATION,
    });

    expect(result.valid).toBe(false);
    expect(result.category).toBe("AUTH_FAILURE");
    expect(result.message).toContain("cannot be empty");
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("successfully validates GENERATION purpose using gemini-3.6-flash", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => "pong" },
    });

    const result = await validateGeminiKey({
      apiKey: "AIzaValidTestKeyForGeneration12345678",
      purpose: CredentialPurpose.GENERATION,
    });

    expect(result.valid).toBe(true);
    expect(result.category).toBe("VALID");
    expect(result.testedModel).toBe("gemini-3.6-flash");
    expect(result.testedModel).toBe(VALIDATION_MODELS.GENERATION);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      "AIzaValidTestKeyForGeneration12345678",
      "gemini-3.6-flash",
      expect.objectContaining({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
      })
    );
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("successfully validates EMBEDDING purpose using gemini-embedding-001", async () => {
    mockEmbedContent.mockResolvedValueOnce({
      embedding: { values: [0.1, 0.2, 0.3] },
    });

    const result = await validateGeminiKey({
      apiKey: "AIzaValidTestKeyForEmbedding123456789",
      purpose: CredentialPurpose.EMBEDDING,
    });

    expect(result.valid).toBe(true);
    expect(result.category).toBe("VALID");
    expect(result.testedModel).toBe("gemini-embedding-001");
    expect(result.testedModel).toBe(VALIDATION_MODELS.EMBEDDING);
    expect(mockEmbedContent).toHaveBeenCalledWith(
      "AIzaValidTestKeyForEmbedding123456789",
      "gemini-embedding-001",
      "ping"
    );
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("handles provider auth failure accurately", async () => {
    const error = Object.assign(
      new Error("API_KEY_INVALID: API key not valid. Please pass a valid API key."),
      { status: 400 }
    );
    mockGenerateContent.mockRejectedValueOnce(error);

    const result = await validateGeminiKey({
      apiKey: "AIzaInvalidKey123456789",
      purpose: CredentialPurpose.GENERATION,
    });

    expect(result.valid).toBe(false);
    expect(result.category).toBe("AUTH_FAILURE");
    expect(result.message).toContain("rejected by Google");
  });

  it("handles provider timeout gracefully", async () => {
    mockGenerateContent.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 300)));

    const result = await validateGeminiKey({
      apiKey: "AIzaSlowKey123456789",
      purpose: CredentialPurpose.GENERATION,
      timeoutMs: 50,
    });

    expect(result.valid).toBe(false);
    expect(result.category).toBe("TRANSIENT_FAILURE");
    expect(result.message).toContain("timed out");
  });
});
