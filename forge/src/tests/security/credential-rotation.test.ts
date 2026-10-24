// src/tests/security/credential-rotation.test.ts
//
// Verification test suite for Production Hardening H2 — Zero-Downtime Credential Rotation.
// Tests error classification, dual-key fallback, environment isolation, secret redaction,
// and QStash worker signature dual-key verification.

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import {
  isGeminiAuthenticationError,
  isPineconeAuthenticationError,
  logCredentialFailover,
  redactSecretPatterns,
  extractGeminiErrorReasons,
} from "@/lib/security/credential-rotation";
import { Receiver } from "@upstash/qstash";
import { isUnsignedWorkerAllowed } from "@/lib/events/worker";
import {
  getVectorEnv,
  aiServerSchema,
  vectorServerDevSchema,
  vectorServerProdSchema,
} from "@/lib/env/server";

describe("Production Hardening H2 — Zero-Downtime Credential Rotation", () => {
  describe("Google Gemini Error Classification (isGeminiAuthenticationError)", () => {
    it("identifies definitive API key invalidity and expired errors", () => {
      const err400Invalid = {
        status: 400,
        message: "API key not valid. Please pass a valid API key.",
      };
      const err400Expired = {
        status: 400,
        message: "API key expired. Please renew the API key.",
      };
      const err401MissingKey = {
        status: 401,
        statusText: "UNAUTHENTICATED",
        message: "Request is missing required authentication credential. Expected API key or token.",
      };
      const errStructuredInvalid = {
        status: 400,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_INVALID",
            domain: "googleapis.com",
          },
        ],
      };
      const errStructuredExpired = {
        status: 400,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_EXPIRED",
            domain: "googleapis.com",
          },
        ],
      };
      const errServiceBlocked = {
        status: 403,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_SERVICE_BLOCKED",
            domain: "googleapis.com",
            metadata: {
              service: "generativelanguage.googleapis.com",
            },
          },
        ],
      };
      const errKeyNotFound = {
        status: 400,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_NOT_FOUND",
            domain: "googleapis.com",
          },
        ],
      };

      expect(isGeminiAuthenticationError(err400Invalid)).toBe(true);
      expect(isGeminiAuthenticationError(err400Expired)).toBe(true);
      expect(isGeminiAuthenticationError(err401MissingKey)).toBe(true);
      expect(isGeminiAuthenticationError(errStructuredInvalid)).toBe(true);
      expect(isGeminiAuthenticationError(errStructuredExpired)).toBe(true);
      expect(isGeminiAuthenticationError(errServiceBlocked)).toBe(true);
      expect(isGeminiAuthenticationError(errKeyNotFound)).toBe(true);
    });

    it("evaluates API_KEY_SERVICE_BLOCKED with target service gating", () => {
      // Matching Gemini service should trigger failover
      const validServiceBlocked = {
        status: 403,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_SERVICE_BLOCKED",
            domain: "googleapis.com",
            metadata: {
              service: "generativelanguage.googleapis.com",
            },
          },
        ],
      };
      expect(isGeminiAuthenticationError(validServiceBlocked)).toBe(true);

      // Unrelated service restriction (e.g. maps) must NOT trigger failover
      const unrelatedServiceBlocked = {
        status: 403,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_SERVICE_BLOCKED",
            domain: "googleapis.com",
            metadata: {
              service: "maps.googleapis.com",
            },
          },
        ],
      };
      expect(isGeminiAuthenticationError(unrelatedServiceBlocked)).toBe(false);

      // AI SDK APICallError with responseBody containing structured ErrorInfo for Gemini
      const aiSdkResponseBodyBlocked = {
        statusCode: 403,
        responseBody: JSON.stringify({
          error: {
            code: 403,
            message: "API keys are blocked on this service.",
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_SERVICE_BLOCKED",
                domain: "googleapis.com",
                metadata: {
                  service: "generativelanguage.googleapis.com",
                },
              },
            ],
          },
        }),
      };
      expect(isGeminiAuthenticationError(aiSdkResponseBodyBlocked)).toBe(true);

      // Unstructured 403 with blocked mention but no structured ErrorInfo fails closed
      const unstructured403 = {
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "API_KEY_SERVICE_BLOCKED on this service without structured proof",
      };
      expect(isGeminiAuthenticationError(unstructured403)).toBe(false);
    });

    it("extracts structured reasons from AI SDK APICallError data format", () => {
      const apiCallError = {
        statusCode: 400,
        message: "API key not valid. Please pass a valid API key.",
        data: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "API key not valid. Please pass a valid API key.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
                domain: "googleapis.com",
              },
            ],
          },
        },
      };

      expect(extractGeminiErrorReasons(apiCallError)).toEqual(["API_KEY_INVALID"]);
      expect(isGeminiAuthenticationError(apiCallError)).toBe(true);
    });

    it("rejects generic 403 PERMISSION_DENIED without definitive API key proof", () => {
      const genericPermissionDenied = {
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "The caller does not have permission",
      };
      const modelAccessDenied = {
        status: 403,
        message: "Caller does not have required IAM permission to access model 'gemini-3.6-flash'.",
      };

      expect(isGeminiAuthenticationError(genericPermissionDenied)).toBe(false);
      expect(isGeminiAuthenticationError(modelAccessDenied)).toBe(false);
    });

    it("rejects project-level, consumer, and billing errors (CONSUMER_INVALID, BILLING_DISABLED)", () => {
      const errConsumerInvalid = {
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "Consumer project 12345 not found or deleted.",
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "CONSUMER_INVALID",
            domain: "googleapis.com",
          },
        ],
      };
      const errBillingDisabled = {
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "Billing account for project 12345 is disabled.",
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "BILLING_DISABLED",
            domain: "googleapis.com",
          },
        ],
      };
      const errServiceDisabled = {
        status: 403,
        message: "Generative Language API has not been used in project before or it is disabled.",
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            domain: "googleapis.com",
          },
        ],
      };

      expect(isGeminiAuthenticationError(errConsumerInvalid)).toBe(false);
      expect(isGeminiAuthenticationError(errBillingDisabled)).toBe(false);
      expect(isGeminiAuthenticationError(errServiceDisabled)).toBe(false);
    });

    it("rejects unrecognized HTTP 400 and 403 errors", () => {
      const badRequest = {
        status: 400,
        statusText: "INVALID_ARGUMENT",
        message: "Invalid JSON payload received. Unknown name 'invalid_param': Cannot find field.",
      };
      const unrecognizedForbidden = {
        status: 403,
        statusText: "FORBIDDEN",
        message: "Forbidden",
      };

      expect(isGeminiAuthenticationError(badRequest)).toBe(false);
      expect(isGeminiAuthenticationError(unrecognizedForbidden)).toBe(false);
    });

    it("never classifies HTTP 429 quota exhaustion / rate limits as auth errors", () => {
      const err429 = { status: 429, message: "RESOURCE_EXHAUSTED: Rate limit exceeded" };
      const errQuota = {
        status: 429,
        message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'",
      };
      const errQuotaStructured = {
        status: 429,
        errorDetails: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
          },
        ],
      };

      expect(isGeminiAuthenticationError(err429)).toBe(false);
      expect(isGeminiAuthenticationError(errQuota)).toBe(false);
      expect(isGeminiAuthenticationError(errQuotaStructured)).toBe(false);
    });

    it("never classifies HTTP 5xx backend server errors as auth errors", () => {
      const err500 = { status: 500, message: "Internal Server Error" };
      const err503 = { status: 503, message: "The service is temporarily unavailable" };

      expect(isGeminiAuthenticationError(err500)).toBe(false);
      expect(isGeminiAuthenticationError(err503)).toBe(false);
    });

    it("never classifies network aborts or non-auth validation issues as auth errors", () => {
      const netErr = { code: "ETIMEDOUT", message: "fetch failed" };
      const promptErr = { status: 400, message: "Invalid JSON payload received. Unknown name 'bad_field'" };
      const safetyErr = { status: 400, message: "Candidate was blocked due to SAFETY" };

      expect(isGeminiAuthenticationError(netErr)).toBe(false);
      expect(isGeminiAuthenticationError(promptErr)).toBe(false);
      expect(isGeminiAuthenticationError(safetyErr)).toBe(false);
      expect(isGeminiAuthenticationError(null)).toBe(false);
      expect(isGeminiAuthenticationError("string error")).toBe(false);
    });
  });

  describe("Pinecone Error Classification (isPineconeAuthenticationError)", () => {
    it("identifies PineconeAuthorizationError and HTTP 401 API key rejection", () => {
      const authErrObj = {
        name: "PineconeAuthorizationError",
        message: "The API key you provided was rejected while calling https://api.pinecone.io.",
      };
      const http401 = { status: 401, message: "Unauthorized: API key is invalid" };
      const code401 = { statusCode: 401, message: "The API key you provided was rejected." };

      expect(isPineconeAuthenticationError(authErrObj)).toBe(true);
      expect(isPineconeAuthenticationError(http401)).toBe(true);
      expect(isPineconeAuthenticationError(code401)).toBe(true);
    });

    it("rejects PineconeBadRequestError (HTTP 403 / insufficient permissions)", () => {
      const err403 = {
        name: "PineconeBadRequestError",
        status: 403,
        statusCode: 403,
        message: "Forbidden: The user does not have permission to perform this action.",
      };
      const permissionDenied = {
        status: 403,
        message: "Insufficient permissions to query index.",
      };

      expect(isPineconeAuthenticationError(err403)).toBe(false);
      expect(isPineconeAuthenticationError(permissionDenied)).toBe(false);
    });

    it("never classifies HTTP 404, HTTP 429, or HTTP 5xx as auth errors", () => {
      const err404 = { name: "PineconeNotFoundError", status: 404, message: "Index or namespace not found" };
      const err429 = { status: 429, message: "Rate limit exceeded" };
      const err500 = { name: "PineconeInternalServerError", status: 500, message: "Pinecone internal error" };
      const err503 = { name: "PineconeUnavailableError", status: 503, message: "Service unavailable" };

      expect(isPineconeAuthenticationError(err404)).toBe(false);
      expect(isPineconeAuthenticationError(err429)).toBe(false);
      expect(isPineconeAuthenticationError(err500)).toBe(false);
      expect(isPineconeAuthenticationError(err503)).toBe(false);
      expect(isPineconeAuthenticationError(null)).toBe(false);
    });
  });

  describe("Diagnostic Secret Redaction and Observability Logging", () => {
    it("redacts Google API key patterns from diagnostics", () => {
      const secret = "AIzaSyB1234567890123456789012345678901";
      const raw = `Error connecting with API key ${secret} failed`;
      const sanitized = redactSecretPatterns(raw);

      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain("[REDACTED_GEMINI_KEY]");
    });

    it("redacts Bearer tokens and generic secrets", () => {
      const raw = "Authorization: Bearer secret-jwt-token-123456789 and api_key='pcsk_abcdef1234567890'";
      const sanitized = redactSecretPatterns(raw);

      expect(sanitized).not.toContain("secret-jwt-token-123456789");
      expect(sanitized).toContain("Bearer [REDACTED_TOKEN]");
      expect(sanitized).toContain("[REDACTED_PINECONE_KEY]");
    });

    it("emits structured audit logs with zero plaintext secret exposure", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const rawApiKey = "AIzaSyB1234567890123456789012345678901";

      logCredentialFailover({
        provider: "gemini",
        subsystem: "ai",
        slot: "primary",
        operation: "doGenerate",
        errorCategory: "AUTH_FAILURE_FAILOVER",
        message: `Key ${rawApiKey} returned API_KEY_INVALID`,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedCall = warnSpy.mock.calls[0][0];

      expect(loggedCall).toContain("[CREDENTIAL_ROTATION]");
      expect(loggedCall).toContain("[GEMINI]");
      expect(loggedCall).toContain("AUTH_FAILURE_FAILOVER");
      expect(loggedCall).not.toContain(rawApiKey);
      expect(loggedCall).toContain("[REDACTED_GEMINI_KEY]");

      warnSpy.mockRestore();
    });
  });

  describe("Environment Segregation & Fallback Schemas", () => {
    it("validates AI schema with optional GEMINI_API_KEY_FALLBACK", () => {
      const validWithoutFallback = aiServerSchema.safeParse({
        GEMINI_API_KEY: "primary-key",
      });
      expect(validWithoutFallback.success).toBe(true);

      const validWithFallback = aiServerSchema.safeParse({
        GEMINI_API_KEY: "primary-key",
        GEMINI_API_KEY_FALLBACK: "secondary-key",
      });
      expect(validWithFallback.success).toBe(true);
      if (validWithFallback.success) {
        expect(validWithFallback.data.GEMINI_API_KEY_FALLBACK).toBe("secondary-key");
      }
    });

    it("strictly segregates DEV and PROD Pinecone schemas", () => {
      const devEnv = {
        PINECONE_API_KEY_DEV: "dev-key-1",
        PINECONE_INDEX_DEV: "dev-index",
        PINECONE_API_KEY_DEV_FALLBACK: "dev-key-2",
      };

      const devParsed = vectorServerDevSchema.safeParse(devEnv);
      expect(devParsed.success).toBe(true);

      // Dev schema must not accept or require PROD keys
      const prodEnv = {
        PINECONE_API_KEY_PROD: "prod-key-1",
        PINECONE_INDEX_PROD: "prod-index",
        PINECONE_API_KEY_PROD_FALLBACK: "prod-key-2",
      };

      const prodParsed = vectorServerProdSchema.safeParse(prodEnv);
      expect(prodParsed.success).toBe(true);

      // Dev environment should parse with getVectorEnv
      const vectorDev = getVectorEnv({
        ...devEnv,
        NODE_ENV: "development",
      });
      expect(vectorDev.apiKey).toBe("dev-key-1");
      expect(vectorDev.fallbackApiKey).toBe("dev-key-2");
      expect(vectorDev.indexName).toBe("dev-index");
      expect(vectorDev.isProd).toBe(false);

      // Prod environment should parse with getVectorEnv
      const vectorProd = getVectorEnv({
        ...prodEnv,
        NODE_ENV: "production",
      });
      expect(vectorProd.apiKey).toBe("prod-key-1");
      expect(vectorProd.fallbackApiKey).toBe("prod-key-2");
      expect(vectorProd.indexName).toBe("prod-index");
      expect(vectorProd.isProd).toBe(true);
    });
  });

  describe("Upstash QStash Dual-Key Signature Verification", () => {
    it("successfully verifies requests when currentSigningKey matches", async () => {
      const receiver = new Receiver({
        currentSigningKey: "current-valid-sig-key",
        nextSigningKey: "next-valid-sig-key",
      });

      const keyAttempts: string[] = [];
      (receiver as any).verifyWithKey = async (key: string) => {
        keyAttempts.push(key);
        if (key === "current-valid-sig-key") {
          return { sub: "test-valid" };
        }
        throw new Error("Invalid signature");
      };
      (receiver as any).verifyBodyAndUrl = () => true;

      const result = await receiver.verify({ upstashRegion: "us-east-1" } as any);
      expect(result).toBe(true);
      expect(keyAttempts).toEqual(["current-valid-sig-key"]);
    });

    it("falls back to nextSigningKey when currentSigningKey fails", async () => {
      const receiver = new Receiver({
        currentSigningKey: "old-rotated-sig-key",
        nextSigningKey: "new-promoted-sig-key",
      });

      const keyAttempts: string[] = [];
      (receiver as any).verifyWithKey = async (key: string) => {
        keyAttempts.push(key);
        if (key === "new-promoted-sig-key") {
          return { sub: "test-valid-on-next" };
        }
        throw new Error("Invalid signature on key: " + key);
      };
      (receiver as any).verifyBodyAndUrl = () => true;

      const result = await receiver.verify({ upstashRegion: "us-east-1" } as any);
      expect(result).toBe(true);
      expect(keyAttempts).toEqual(["old-rotated-sig-key", "new-promoted-sig-key"]);
    });

    it("rejects verification if both current and next keys fail", async () => {
      const receiver = new Receiver({
        currentSigningKey: "invalid-key-1",
        nextSigningKey: "invalid-key-2",
      });

      (receiver as any).verifyWithKey = async () => {
        throw new Error("Signature verification failed");
      };
      (receiver as any).verifyBodyAndUrl = () => true;

      await expect(receiver.verify({ upstashRegion: "us-east-1" } as any)).rejects.toThrow(
        "Signature verification failed"
      );
    });

    it("enforces that production workers never accept unsigned requests", () => {
      const originalEnv = { ...process.env };

      try {
        // Even when explicitly requested, production refuses unsigned workers
        process.env.ALLOW_UNSIGNED_LOCAL_WORKER = "true";
        (process.env as any).NODE_ENV = "production";
        expect(isUnsignedWorkerAllowed()).toBe(false);

        // Outside production, explicit opt-in is respected
        (process.env as any).NODE_ENV = "development";
        expect(isUnsignedWorkerAllowed()).toBe(true);

        // Outside production without explicit flag, unsigned workers are refused
        process.env.ALLOW_UNSIGNED_LOCAL_WORKER = "false";
        expect(isUnsignedWorkerAllowed()).toBe(false);
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe("Runtime Provider Failover Mechanics", () => {
    it("handles Gemini language model failover when primary auth fails", async () => {
      const primaryDoGenerate = jest.fn().mockRejectedValue({
        status: 400,
        message: "API key not valid. Please pass a valid API key.",
      });
      const fallbackDoGenerate = jest.fn().mockResolvedValue({
        text: "Fallback generation succeeded",
      });

      const primaryModel = {
        modelId: "gemini-3.6-flash",
        provider: "google.generative-ai",
        specificationVersion: "v1",
        doGenerate: primaryDoGenerate,
        doStream: jest.fn(),
      };

      const fallbackModel = {
        modelId: "gemini-3.6-flash",
        provider: "google.generative-ai",
        specificationVersion: "v1",
        doGenerate: fallbackDoGenerate,
        doStream: jest.fn(),
      };

      const wrapped = Object.create(primaryModel);
      wrapped.doGenerate = async function (options: any) {
        try {
          return await primaryModel.doGenerate(options);
        } catch (err) {
          if (isGeminiAuthenticationError(err)) {
            logCredentialFailover({
              provider: "gemini",
              subsystem: "ai",
              slot: "primary",
              operation: "doGenerate",
              errorCategory: "AUTH_FAILURE_FAILOVER",
              message: err instanceof Error ? err.message : String(err),
            });
            return await fallbackModel.doGenerate(options);
          }
          throw err;
        }
      };

      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const result = await wrapped.doGenerate({ prompt: "test" });

      expect(result).toEqual({ text: "Fallback generation succeeded" });
      expect(primaryDoGenerate).toHaveBeenCalledTimes(1);
      expect(fallbackDoGenerate).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("does not trigger Gemini failover on 429 quota exhaustion or generic 403 PERMISSION_DENIED", async () => {
      const primaryDoGenerate429 = jest.fn().mockRejectedValue({
        status: 429,
        message: "RESOURCE_EXHAUSTED",
      });
      const primaryDoGenerate403 = jest.fn().mockRejectedValue({
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "The caller does not have permission",
      });
      const fallbackDoGenerate = jest.fn();

      const createWrapped = (mockPrimary: jest.Mock) => {
        const primaryModel = {
          modelId: "gemini-3.6-flash",
          provider: "google.generative-ai",
          specificationVersion: "v1",
          doGenerate: mockPrimary,
        };
        const fallbackModel = {
          modelId: "gemini-3.6-flash",
          provider: "google.generative-ai",
          specificationVersion: "v1",
          doGenerate: fallbackDoGenerate,
        };

        const wrapped = Object.create(primaryModel);
        wrapped.doGenerate = async function (options: any) {
          try {
            return await primaryModel.doGenerate(options);
          } catch (err) {
            if (isGeminiAuthenticationError(err)) {
              return await fallbackModel.doGenerate(options);
            }
            throw err;
          }
        };
        return wrapped;
      };

      const wrapped429 = createWrapped(primaryDoGenerate429);
      await expect(wrapped429.doGenerate({ prompt: "test" })).rejects.toEqual({
        status: 429,
        message: "RESOURCE_EXHAUSTED",
      });

      const wrapped403 = createWrapped(primaryDoGenerate403);
      await expect(wrapped403.doGenerate({ prompt: "test" })).rejects.toEqual({
        status: 403,
        statusText: "PERMISSION_DENIED",
        message: "The caller does not have permission",
      });

      expect(fallbackDoGenerate).not.toHaveBeenCalled();
    });

    it("permits exactly one fallback attempt and rethrows if fallback also fails", async () => {
      const primaryDoGenerate = jest.fn().mockRejectedValue({
        status: 400,
        message: "API key not valid. Please pass a valid API key.",
      });
      const fallbackDoGenerate = jest.fn().mockRejectedValue({
        status: 400,
        message: "Fallback key also invalid",
      });

      const primaryModel = { doGenerate: primaryDoGenerate };
      const fallbackModel = { doGenerate: fallbackDoGenerate };

      const wrapped = Object.create(primaryModel);
      wrapped.doGenerate = async function (options: any) {
        try {
          return await primaryModel.doGenerate(options);
        } catch (err) {
          if (isGeminiAuthenticationError(err)) {
            return await fallbackModel.doGenerate(options);
          }
          throw err;
        }
      };

      await expect(wrapped.doGenerate({ prompt: "test" })).rejects.toEqual({
        status: 400,
        message: "Fallback key also invalid",
      });

      expect(primaryDoGenerate).toHaveBeenCalledTimes(1);
      expect(fallbackDoGenerate).toHaveBeenCalledTimes(1);
    });

    it("handles Pinecone tenant store failover on authorization error", async () => {
      const primaryQuery = jest.fn().mockRejectedValue({
        name: "PineconeAuthorizationError",
        message: "The API key you provided was rejected while calling https://api.pinecone.io.",
      });
      const fallbackQuery = jest.fn().mockResolvedValue({
        matches: [{ id: "vec-1", score: 0.99 }],
      });

      const primaryNs = { query: primaryQuery };
      const fallbackNs = { query: fallbackQuery };

      async function executeWithFailover(operation: string, action: (ns: any) => Promise<any>) {
        try {
          return await action(primaryNs);
        } catch (err) {
          if (fallbackNs && isPineconeAuthenticationError(err)) {
            logCredentialFailover({
              provider: "pinecone",
              subsystem: "vector",
              slot: "primary",
              operation,
              errorCategory: "AUTH_FAILURE_FAILOVER",
              message: err instanceof Error ? err.message : String(err),
            });
            return await action(fallbackNs);
          }
          throw err;
        }
      }

      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const result = await executeWithFailover("query", (ns) =>
        ns.query({ vector: [0.1, 0.2], topK: 1 })
      );

      expect(result).toEqual({ matches: [{ id: "vec-1", score: 0.99 }] });
      expect(primaryQuery).toHaveBeenCalledTimes(1);
      expect(fallbackQuery).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("does not trigger Pinecone failover on 403 insufficient permissions or 404", async () => {
      const primaryQuery403 = jest.fn().mockRejectedValue({
        name: "PineconeBadRequestError",
        status: 403,
        message: "Forbidden: The user does not have permission.",
      });
      const primaryQuery404 = jest.fn().mockRejectedValue({
        name: "PineconeNotFoundError",
        status: 404,
        message: "Index not found",
      });
      const fallbackQuery = jest.fn();

      async function executeWithFailover(primaryFn: jest.Mock) {
        try {
          return await primaryFn();
        } catch (err) {
          if (isPineconeAuthenticationError(err)) {
            return await fallbackQuery();
          }
          throw err;
        }
      }

      await expect(executeWithFailover(primaryQuery403)).rejects.toMatchObject({
        name: "PineconeBadRequestError",
        status: 403,
      });

      await expect(executeWithFailover(primaryQuery404)).rejects.toMatchObject({
        name: "PineconeNotFoundError",
        status: 404,
      });

      expect(fallbackQuery).not.toHaveBeenCalled();
    });
  });
});
