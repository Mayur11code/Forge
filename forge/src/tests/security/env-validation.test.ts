import fs from "fs";
import path from "path";
import {
  getCoreEnv,
  getAiEnv,
  getQstashEnv,
  getRedisEnv,
  getPusherServerEnv,
  getVectorEnv,
  getBillingEnv,
  getEmailEnv,
  getStorageEnv,
  validateAllServerEnv,
  EnvValidationError,
} from "@/lib/env/server";
import { clientEnvSchema, getClientEnv } from "@/lib/env/client";

describe("Production Hardening H1 — Environment Validation & Airgap", () => {
  const validMockServerEnv: Record<string, string> = {
    DATABASE_URL: "postgresql://postgres:secret123@db.example.com:5432/forge?schema=public",
    AUTH_SECRET: "very-secure-random-auth-token-32-chars",
    APP_URL: "http://localhost:3000",
    NODE_ENV: "test",
    GEMINI_API_KEY: "mock-gemini-key-xyz",
    AGENT_APPROVAL_TIMEOUT_MS: "300000",
    QSTASH_URL: "https://qstash.upstash.io",
    QSTASH_TOKEN: "mock-qstash-token",
    UPSTASH_REDIS_REST_URL: "https://redis.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "mock-redis-token",
    PUSHER_APP_ID: "pusher-app-id-1",
    PUSHER_SECRET: "pusher-secret-token",
    NEXT_PUBLIC_PUSHER_KEY: "pusher-public-key",
    NEXT_PUBLIC_PUSHER_CLUSTER: "mt1",
    PINECONE_API_KEY_DEV: "pinecone-key-dev",
    PINECONE_INDEX_DEV: "index-dev",
    PINECONE_API_KEY_PROD: "pinecone-key-prod",
    PINECONE_INDEX_PROD: "index-prod",
    RAZORPAY_KEY_ID: "rzp_id_123",
    RAZORPAY_KEY_SECRET: "rzp_sec_456",
    RAZORPAY_PLAN_ID: "plan_789",
    RESEND_API_KEY: "re_mock_api_key",
    UPLOADTHING_TOKEN: "mock-uploadthing-token",
    ALLOW_UNSIGNED_LOCAL_WORKER: "false",
  };

  describe("Subsystem Validation Schemas", () => {
    it("validates valid core server environment", () => {
      const parsed = getCoreEnv(validMockServerEnv);
      expect(parsed.DATABASE_URL).toBe(validMockServerEnv.DATABASE_URL);
      expect(parsed.AUTH_SECRET).toBe(validMockServerEnv.AUTH_SECRET);
      expect(parsed.ALLOW_UNSIGNED_LOCAL_WORKER).toBe("false");
    });

    it("rejects non-postgres DATABASE_URL", () => {
      const invalid = {
        ...validMockServerEnv,
        DATABASE_URL: "mysql://user:pass@host:3306/db",
      };
      expect(() => getCoreEnv(invalid)).toThrow(EnvValidationError);
      expect(() => getCoreEnv(invalid)).toThrow(/PostgreSQL connection string/);
    });

    it("validates AI environment and coerces AGENT_APPROVAL_TIMEOUT_MS", () => {
      const parsed = getAiEnv({
        GEMINI_API_KEY: "valid-gemini-key",
        AGENT_APPROVAL_TIMEOUT_MS: "600000",
      });
      expect(parsed.GEMINI_API_KEY).toBe("valid-gemini-key");
      expect(parsed.AGENT_APPROVAL_TIMEOUT_MS).toBe(600000);
    });

    it("fails AI validation when GEMINI_API_KEY is missing", () => {
      expect(() => getAiEnv({})).toThrow(EnvValidationError);
      expect(() => getAiEnv({})).toThrow(/GEMINI_API_KEY/);
    });

    it("defaults ENABLE_SEMANTIC_CACHE to false when it is not set", () => {
      const parsed = getAiEnv({ GEMINI_API_KEY: "valid-gemini-key" });
      expect(parsed.ENABLE_SEMANTIC_CACHE).toBe("false");
    });

    it("accepts explicit ENABLE_SEMANTIC_CACHE=false", () => {
      const parsed = getAiEnv({
        GEMINI_API_KEY: "valid-gemini-key",
        ENABLE_SEMANTIC_CACHE: "false",
      });
      expect(parsed.ENABLE_SEMANTIC_CACHE).toBe("false");
    });

    it("accepts explicit ENABLE_SEMANTIC_CACHE=true", () => {
      const parsed = getAiEnv({
        GEMINI_API_KEY: "valid-gemini-key",
        ENABLE_SEMANTIC_CACHE: "true",
      });
      expect(parsed.ENABLE_SEMANTIC_CACHE).toBe("true");
    });

    it.each(["1", "TRUE", "yes", "enabled", ""])(
      "rejects malformed ENABLE_SEMANTIC_CACHE value %p",
      (value) => {
        expect(() =>
          getAiEnv({
            GEMINI_API_KEY: "valid-gemini-key",
            ENABLE_SEMANTIC_CACHE: value,
          })
        ).toThrow(EnvValidationError);
        expect(() =>
          getAiEnv({
            GEMINI_API_KEY: "valid-gemini-key",
            ENABLE_SEMANTIC_CACHE: value,
          })
        ).toThrow(/ENABLE_SEMANTIC_CACHE/);
      }
    );

    it("validates QStash environment and rejects malformed URLs", () => {
      const parsed = getQstashEnv({
        QSTASH_URL: "https://qstash.upstash.io",
        QSTASH_TOKEN: "valid-token",
      });
      expect(parsed.QSTASH_URL).toBe("https://qstash.upstash.io");

      expect(() =>
        getQstashEnv({
          QSTASH_URL: "not-a-valid-url",
          QSTASH_TOKEN: "valid-token",
        })
      ).toThrow(EnvValidationError);
    });

    it("validates Redis environment", () => {
      const parsed = getRedisEnv({
        UPSTASH_REDIS_REST_URL: "https://redis.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      });
      expect(parsed.UPSTASH_REDIS_REST_URL).toBe("https://redis.upstash.io");

      expect(() => getRedisEnv({})).toThrow(/UPSTASH_REDIS_REST_URL/);
    });

    it("validates Pusher server environment", () => {
      const parsed = getPusherServerEnv({
        PUSHER_APP_ID: "app_id",
        PUSHER_SECRET: "secret",
        NEXT_PUBLIC_PUSHER_KEY: "pub_key",
        NEXT_PUBLIC_PUSHER_CLUSTER: "mt1",
      });
      expect(parsed.PUSHER_SECRET).toBe("secret");

      expect(() => getPusherServerEnv({})).toThrow(/PUSHER_APP_ID/);
    });

    it("selects DEV Pinecone credentials when NODE_ENV is development or test", () => {
      const env = {
        NODE_ENV: "test",
        PINECONE_API_KEY_DEV: "dev-key",
        PINECONE_INDEX_DEV: "dev-index",
      };
      const parsed = getVectorEnv(env);
      expect(parsed.isProd).toBe(false);
      expect(parsed.apiKey).toBe("dev-key");
      expect(parsed.indexName).toBe("dev-index");
    });

    it("selects PROD Pinecone credentials when NODE_ENV or VERCEL_ENV is production", () => {
      const env = {
        NODE_ENV: "production",
        PINECONE_API_KEY_PROD: "prod-key",
        PINECONE_INDEX_PROD: "prod-index",
      };
      const parsed = getVectorEnv(env);
      expect(parsed.isProd).toBe(true);
      expect(parsed.apiKey).toBe("prod-key");
      expect(parsed.indexName).toBe("prod-index");
    });

    it("fails Pinecone validation in production when PROD credentials are missing", () => {
      const env = {
        NODE_ENV: "production",
        PINECONE_API_KEY_DEV: "dev-key",
        PINECONE_INDEX_DEV: "dev-index",
      };
      expect(() => getVectorEnv(env)).toThrow(EnvValidationError);
      expect(() => getVectorEnv(env)).toThrow(/PINECONE_API_KEY_PROD/);
    });

    it("validates billing and email environments", () => {
      const billing = getBillingEnv({
        RAZORPAY_KEY_ID: "key_id",
        RAZORPAY_KEY_SECRET: "secret",
        RAZORPAY_PLAN_ID: "plan_1",
      });
      expect(billing.RAZORPAY_KEY_ID).toBe("key_id");

      const email = getEmailEnv({
        RESEND_API_KEY: "re_test_key",
      });
      expect(email.RESEND_API_KEY).toBe("re_test_key");

      const storage = getStorageEnv({
        UPLOADTHING_TOKEN: "ut_token",
      });
      expect(storage.UPLOADTHING_TOKEN).toBe("ut_token");
    });

    it("validates full environment audit without errors on complete mock", () => {
      const full = validateAllServerEnv(validMockServerEnv);
      expect(full.DATABASE_URL).toBeDefined();
      expect(full.GEMINI_API_KEY).toBeDefined();
      expect(full.QSTASH_TOKEN).toBeDefined();
    });
  });

  describe("Secret Masking in Diagnostic Errors", () => {
    it("never discloses sensitive input values in validation error messages", () => {
      const secretDatabaseUrl = "postgresql://user:SUPER_SECRET_PASSWORD@db.example.com:5432/prod";
      const badEnv = {
        DATABASE_URL: "invalid-not-postgres://" + secretDatabaseUrl,
        AUTH_SECRET: "",
      };

      try {
        getCoreEnv(badEnv);
        fail("Should have thrown EnvValidationError");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const err = error as EnvValidationError;
        expect(err.message).not.toContain("SUPER_SECRET_PASSWORD");
        expect(err.message).toContain("DATABASE_URL");
        expect(err.message).toContain("Security Note: Credential values are masked");
      }
    });

    it("never includes rejected API key values in AI validation error messages", () => {
      const badAiEnv = {
        GEMINI_API_KEY: "",
      };

      try {
        getAiEnv(badAiEnv);
        fail("Should have thrown EnvValidationError");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const err = error as EnvValidationError;
        expect(err.message).toContain("GEMINI_API_KEY");
        expect(err.message).not.toContain("received ''");
      }
    });
  });

  describe("Client Public Configuration Airgap", () => {
    it("allows valid NEXT_PUBLIC_ variables", () => {
      const result = clientEnvSchema.safeParse({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_PUSHER_KEY: "push-key",
        NEXT_PUBLIC_PUSHER_CLUSTER: "mt1",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("strictly isolates client schema from server secrets", () => {
      const mixedEnv = {
        ...validMockServerEnv,
        NEXT_PUBLIC_APP_URL: "https://forge.example.com",
      };

      const parsed = clientEnvSchema.parse(mixedEnv);
      const keys = Object.keys(parsed);

      expect(keys).toEqual(
        expect.arrayContaining(["NEXT_PUBLIC_APP_URL"])
      );
      expect(keys).not.toContain("DATABASE_URL");
      expect(keys).not.toContain("AUTH_SECRET");
      expect(keys).not.toContain("GEMINI_API_KEY");
      expect(keys).not.toContain("QSTASH_TOKEN");
      expect(keys).not.toContain("PUSHER_SECRET");
      expect(keys).not.toContain("UPSTASH_REDIS_REST_TOKEN");
    });

    it("evaluates getClientEnv returning typed client environment", () => {
      const client = getClientEnv();
      expect(client).toBeDefined();
      expect(typeof client.NEXT_PUBLIC_APP_URL).toBe("string");
    });
  });

  describe("Server-Only Boundary Verification on Sensitive Modules", () => {
    const sensitiveFiles = [
      "src/lib/env/server.ts",
      "src/lib/prisma/db.ts",
      "src/lib/ai/provider.ts",
      "src/lib/ai/agent/model.ts",
      "src/lib/events/queue.ts",
      "src/lib/events/worker.ts",
      "src/lib/redis/client.ts",
      "src/lib/vector/client.ts",
      "src/lib/pusher/pusher-server.ts",
      "src/lib/emails/email.ts",
      "src/app/api/worker/embedding-worker/ew.ts",
      "src/lib/auth/auth.ts",
      "src/lib/security/credential-rotation.ts",
      "src/lib/security/rate-limit.ts",
      "src/lib/redis/rate-limit.ts",
      "src/lib/security/vault/encryption.ts",
      "src/lib/security/vault/service.ts",
      "src/lib/security/vault/index.ts",
    ];

    test.each(sensitiveFiles)(
      "file %s enforces the server-only boundary",
      (relativePath) => {
        const fullPath = path.resolve(process.cwd(), relativePath);
        expect(fs.existsSync(fullPath)).toBe(true);
        const content = fs.readFileSync(fullPath, "utf-8");
        const hasServerOnly =
          content.includes('import "server-only";') ||
          content.includes("import 'server-only';");
        expect(hasServerOnly).toBe(true);
      }
    );

    it("client environment module src/lib/env/client.ts does NOT import server-only", () => {
      const clientPath = path.resolve(process.cwd(), "src/lib/env/client.ts");
      const content = fs.readFileSync(clientPath, "utf-8");
      expect(content).not.toContain("server-only");
    });

    it("browser client src/lib/pusher/pusher-client.ts does NOT import server-only", () => {
      const pusherClientPath = path.resolve(process.cwd(), "src/lib/pusher/pusher-client.ts");
      const content = fs.readFileSync(pusherClientPath, "utf-8");
      expect(content).not.toContain("server-only");
    });

    it("edge middleware src/middleware.ts and auth.config.ts do NOT import server-only", () => {
      const mwPath = path.resolve(process.cwd(), "src/middleware.ts");
      const mwContent = fs.readFileSync(mwPath, "utf-8");
      expect(mwContent).not.toContain("server-only");

      const authCfgPath = path.resolve(process.cwd(), "src/lib/auth/auth.config.ts");
      const authCfgContent = fs.readFileSync(authCfgPath, "utf-8");
      expect(authCfgContent).not.toContain("server-only");
    });
  });
});
