import "server-only";
import { z } from "zod";

/**
 * Custom error class for environment configuration failures.
 * Ensures diagnostic messages are actionable while strictly redacting
 * credential values to prevent log or console disclosure.
 */
export class EnvValidationError extends Error {
  public readonly variableErrors: Array<{ variable: string; message: string }>;
  public readonly subsystem?: string;

  constructor(errors: Array<{ variable: string; message: string }>, subsystem?: string) {
    const prefix = subsystem ? `[${subsystem}] ` : "";
    const lines = errors.map((e) => `  - [${e.variable}]: ${e.message}`);
    super(
      `${prefix}Environment validation failed:\n${lines.join("\n")}\n` +
        `Security Note: Credential values are masked in error diagnostics to prevent secret leakage.`
    );
    this.name = "EnvValidationError";
    this.subsystem = subsystem;
    this.variableErrors = errors;
  }
}

/**
 * Sanitizes Zod issues to guarantee no input credential values appear in error messages.
 */
export function formatZodIssues(
  issues: z.ZodIssue[]
): Array<{ variable: string; message: string }> {
  return issues.map((issue) => {
    const variable = issue.path.join(".") || "UNKNOWN_VARIABLE";
    let message = issue.message;

    // Mask any potential raw values that Zod or refinements might embed
    if (issue.code === "invalid_type" && (issue as { received?: string }).received === "undefined") {
      message = "Required environment variable is missing";
    } else if (issue.code === "custom" && !message) {
      message = "Value failed format validation";
    }

    return { variable, message };
  });
}

// ---------------------------------------------------------------------------
// Subsystem Schemas
// ---------------------------------------------------------------------------

/**
 * 1. Core Server Runtime & Database
 */
export const coreServerSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (val) => val.startsWith("postgresql://") || val.startsWith("postgres://"),
      {
        message: "DATABASE_URL must be a PostgreSQL connection string (postgresql:// or postgres://)",
      }
    ),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  APP_URL: z
    .string()
    .url("APP_URL must be a valid URL")
    .optional()
    .or(z.literal("")),
  ALLOW_UNSIGNED_LOCAL_WORKER: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
});

/**
 * 2. Google Gemini AI & Agent Loop
 */
export const aiServerSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required for Google Gemini AI integration"),
  GEMINI_API_KEY_FALLBACK: z.string().min(1).optional(),
  AGENT_APPROVAL_TIMEOUT_MS: z.coerce
    .number()
    .positive("AGENT_APPROVAL_TIMEOUT_MS must be a positive number")
    .default(600000),
  AGENT_LOOP_REQUESTED_TOPIC: z.string().optional(),
});

/**
 * 3. Upstash QStash Asynchronous Queue
 */
export const qstashServerSchema = z.object({
  QSTASH_URL: z.string().min(1, "QSTASH_URL is required").refine(
    (val) => {
      try {
        const u = new URL(val);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "QSTASH_URL must be a valid URL" }
  ),
  QSTASH_TOKEN: z.string().min(1, "QSTASH_TOKEN is required"),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
});

/**
 * 4. Upstash Redis (Locks, Rate Limiting, Cache)
 */
export const redisServerSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.string().min(1, "UPSTASH_REDIS_REST_URL is required").refine(
    (val) => {
      try {
        const u = new URL(val);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "UPSTASH_REDIS_REST_URL must be a valid URL" }
  ),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1, "UPSTASH_REDIS_REST_TOKEN is required"),
});

/**
 * 5. Pusher Server Realtime
 */
export const pusherServerSchema = z.object({
  PUSHER_APP_ID: z.string().min(1, "PUSHER_APP_ID is required"),
  PUSHER_SECRET: z.string().min(1, "PUSHER_SECRET is required"),
  NEXT_PUBLIC_PUSHER_KEY: z.string().min(1, "NEXT_PUBLIC_PUSHER_KEY is required for Pusher"),
  NEXT_PUBLIC_PUSHER_CLUSTER: z.string().min(1, "NEXT_PUBLIC_PUSHER_CLUSTER is required for Pusher"),
});

/**
 * 6. Pinecone Vector Database (Dev vs Prod environment-aware)
 */
export const vectorServerDevSchema = z.object({
  PINECONE_API_KEY_DEV: z.string().min(1, "PINECONE_API_KEY_DEV is required in development/preview"),
  PINECONE_INDEX_DEV: z.string().min(1, "PINECONE_INDEX_DEV is required in development/preview"),
  PINECONE_API_KEY_DEV_FALLBACK: z.string().min(1).optional(),
});

export const vectorServerProdSchema = z.object({
  PINECONE_API_KEY_PROD: z.string().min(1, "PINECONE_API_KEY_PROD is required in production"),
  PINECONE_INDEX_PROD: z.string().min(1, "PINECONE_INDEX_PROD is required in production"),
  PINECONE_API_KEY_PROD_FALLBACK: z.string().min(1).optional(),
});

/**
 * 7. Razorpay Billing
 */
export const billingServerSchema = z.object({
  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  RAZORPAY_PLAN_ID: z.string().min(1, "RAZORPAY_PLAN_ID is required"),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

/**
 * 8. Resend Email
 */
export const emailServerSchema = z.object({
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
});

/**
 * 9. UploadThing File Storage
 */
export const storageServerSchema = z.object({
  UPLOADTHING_TOKEN: z.string().min(1, "UPLOADTHING_TOKEN is required"),
});

/**
 * 10. Credential Vault & BYOK (Server-Only Secrets)
 * Note: FORGE_VAULT_ENCRYPTION_KEY is optional at boot time so deployments
 * or build steps without BYOK configured boot cleanly without errors.
 * Missing or malformed encryption configuration fails closed on-demand inside the vault module.
 */
export const vaultServerSchema = z.object({
  FORGE_VAULT_ENCRYPTION_KEY: z.string().optional(),
  FORGE_VAULT_PRIMARY_KEY_VERSION: z.string().min(1).default("v1"),
  FORGE_VAULT_KEYRING_JSON: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Subsystem Validation Getters
// ---------------------------------------------------------------------------

function validateWithSchema<T>(
  schema: z.ZodType<T>,
  data: unknown,
  subsystem: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new EnvValidationError(formatZodIssues(result.error.issues), subsystem);
  }
  return result.data;
}

export function getCoreEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(coreServerSchema, env, "CORE");
}

export function getAiEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(aiServerSchema, env, "AI");
}

export function getQstashEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(qstashServerSchema, env, "QSTASH");
}

export function getRedisEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(redisServerSchema, env, "REDIS");
}

export function getPusherServerEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(pusherServerSchema, env, "PUSHER_SERVER");
}

export function getVectorEnv(env: Record<string, string | undefined> = process.env) {
  const isProd = env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
  if (isProd) {
    const prod = validateWithSchema(vectorServerProdSchema, env, "VECTOR_PROD");
    return {
      apiKey: prod.PINECONE_API_KEY_PROD,
      fallbackApiKey: prod.PINECONE_API_KEY_PROD_FALLBACK,
      indexName: prod.PINECONE_INDEX_PROD,
      isProd: true,
    };
  } else {
    const dev = validateWithSchema(vectorServerDevSchema, env, "VECTOR_DEV");
    return {
      apiKey: dev.PINECONE_API_KEY_DEV,
      fallbackApiKey: dev.PINECONE_API_KEY_DEV_FALLBACK,
      indexName: dev.PINECONE_INDEX_DEV,
      isProd: false,
    };
  }
}

export function getBillingEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(billingServerSchema, env, "BILLING");
}

export function getEmailEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(emailServerSchema, env, "EMAIL");
}

export function getStorageEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(storageServerSchema, env, "STORAGE");
}

export function getVaultEnv(env: Record<string, string | undefined> = process.env) {
  return validateWithSchema(vaultServerSchema, env, "VAULT");
}

// ---------------------------------------------------------------------------
// Comprehensive Full Server Schema (for explicit full-environment audits)
// ---------------------------------------------------------------------------

export const fullServerEnvSchema = coreServerSchema
  .merge(aiServerSchema)
  .merge(qstashServerSchema)
  .merge(redisServerSchema)
  .merge(pusherServerSchema)
  .merge(billingServerSchema.partial({ RAZORPAY_WEBHOOK_SECRET: true }))
  .merge(emailServerSchema.partial())
  .merge(storageServerSchema.partial())
  .merge(vaultServerSchema)
  .extend({
    PINECONE_API_KEY_DEV: z.string().optional(),
    PINECONE_INDEX_DEV: z.string().optional(),
    PINECONE_API_KEY_DEV_FALLBACK: z.string().optional(),
    PINECONE_API_KEY_PROD: z.string().optional(),
    PINECONE_INDEX_PROD: z.string().optional(),
    PINECONE_API_KEY_PROD_FALLBACK: z.string().optional(),
  });

export function validateAllServerEnv(env: Record<string, string | undefined> = process.env) {
  const result = fullServerEnvSchema.safeParse(env);
  if (!result.success) {
    throw new EnvValidationError(formatZodIssues(result.error.issues), "FULL_ENV");
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Dynamic On-Demand Server Environment Accessor
// ---------------------------------------------------------------------------

export type ServerEnvAccessor = {
  DATABASE_URL: string;
  AUTH_SECRET: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  APP_URL?: string;
  ALLOW_UNSIGNED_LOCAL_WORKER: "true" | "false";
  NODE_ENV: "development" | "test" | "production";
  VERCEL_ENV?: "development" | "preview" | "production";
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY: string;
  GEMINI_API_KEY_FALLBACK?: string;
  AGENT_APPROVAL_TIMEOUT_MS: number;
  AGENT_LOOP_REQUESTED_TOPIC?: string;
  QSTASH_URL: string;
  QSTASH_TOKEN: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  PUSHER_APP_ID: string;
  PUSHER_SECRET: string;
  NEXT_PUBLIC_PUSHER_KEY: string;
  NEXT_PUBLIC_PUSHER_CLUSTER: string;
  PINECONE_API_KEY_DEV?: string;
  PINECONE_INDEX_DEV?: string;
  PINECONE_API_KEY_DEV_FALLBACK?: string;
  PINECONE_API_KEY_PROD?: string;
  PINECONE_INDEX_PROD?: string;
  PINECONE_API_KEY_PROD_FALLBACK?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_PLAN_ID?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  UPLOADTHING_TOKEN?: string;
  FORGE_VAULT_ENCRYPTION_KEY?: string;
  FORGE_VAULT_PRIMARY_KEY_VERSION: string;
  FORGE_VAULT_KEYRING_JSON?: string;
};

/**
 * On-demand, feature-scoped server environment proxy.
 * Validates variables according to their subsystem upon property access,
 * ensuring fail-fast behavior before privileged operations execute
 * while never failing unrelated build steps.
 */
export const serverEnv = new Proxy({} as ServerEnvAccessor, {
  get(_target, prop: string) {
    switch (prop) {
      case "DATABASE_URL":
      case "AUTH_SECRET":
      case "AUTH_GOOGLE_ID":
      case "AUTH_GOOGLE_SECRET":
      case "APP_URL":
      case "ALLOW_UNSIGNED_LOCAL_WORKER":
      case "NODE_ENV":
      case "VERCEL_ENV":
      case "OPENAI_API_KEY": {
        const core = getCoreEnv();
        return core[prop as keyof typeof core];
      }
      case "GEMINI_API_KEY":
      case "GEMINI_API_KEY_FALLBACK":
      case "AGENT_APPROVAL_TIMEOUT_MS":
      case "AGENT_LOOP_REQUESTED_TOPIC": {
        const ai = getAiEnv();
        return ai[prop as keyof typeof ai];
      }
      case "QSTASH_URL":
      case "QSTASH_TOKEN":
      case "QSTASH_CURRENT_SIGNING_KEY":
      case "QSTASH_NEXT_SIGNING_KEY": {
        const qstash = getQstashEnv();
        return qstash[prop as keyof typeof qstash];
      }
      case "UPSTASH_REDIS_REST_URL":
      case "UPSTASH_REDIS_REST_TOKEN": {
        const redis = getRedisEnv();
        return redis[prop as keyof typeof redis];
      }
      case "PUSHER_APP_ID":
      case "PUSHER_SECRET":
      case "NEXT_PUBLIC_PUSHER_KEY":
      case "NEXT_PUBLIC_PUSHER_CLUSTER": {
        const pusher = getPusherServerEnv();
        return pusher[prop as keyof typeof pusher];
      }
      case "RAZORPAY_KEY_ID":
      case "RAZORPAY_KEY_SECRET":
      case "RAZORPAY_PLAN_ID": {
        const billing = getBillingEnv();
        return billing[prop as keyof typeof billing];
      }
      case "RAZORPAY_WEBHOOK_SECRET": {
        return process.env.RAZORPAY_WEBHOOK_SECRET;
      }
      case "RESEND_API_KEY": {
        const email = getEmailEnv();
        return email.RESEND_API_KEY;
      }
      case "UPLOADTHING_TOKEN": {
        const storage = getStorageEnv();
        return storage.UPLOADTHING_TOKEN;
      }
      case "FORGE_VAULT_ENCRYPTION_KEY":
      case "FORGE_VAULT_PRIMARY_KEY_VERSION":
      case "FORGE_VAULT_KEYRING_JSON": {
        const vault = getVaultEnv();
        return vault[prop as keyof typeof vault];
      }
      default:
        return process.env[prop];
    }
  },
});
