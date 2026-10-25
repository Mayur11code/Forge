import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { CredentialPurpose } from "@prisma/client";
import {
  isGeminiAuthenticationError,
  extractGeminiErrorDetails,
  redactSecretPatterns,
} from "@/lib/security/credential-rotation";

export type ValidationCategory =
  | "VALID"
  | "AUTH_FAILURE"
  | "PERMISSION_DENIED"
  | "QUOTA_EXHAUSTED"
  | "TRANSIENT_FAILURE"
  | "INVALID_REQUEST";

export interface KeyValidationResult {
  valid: boolean;
  category: ValidationCategory;
  message: string;
  testedModel: string;
  latencyMs: number;
}

export interface ValidateKeyOptions {
  apiKey: string;
  purpose: CredentialPurpose;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
export const VALIDATION_MODELS = {
  GENERATION: "gemini-3.6-flash",
  EMBEDDING: "gemini-embedding-001",
} as const;

/**
 * Classifies an unknown error caught during Gemini API validation.
 * Sanitizes all output with redactSecretPatterns to ensure zero credential disclosure.
 */
export function classifyGeminiValidationError(error: unknown): {
  category: ValidationCategory;
  message: string;
} {
  if (!error) {
    return {
      category: "INVALID_REQUEST",
      message: "Unknown error during credential validation.",
    };
  }

  const rawMsg = error instanceof Error ? error.message : String(error);
  const sanitizedMsg = redactSecretPatterns(rawMsg);

  // 1. Check for timeout
  if (
    rawMsg.includes("VALIDATION_TIMEOUT") ||
    rawMsg.includes("aborted") ||
    (typeof error === "object" && (error as { name?: string }).name === "AbortError")
  ) {
    return {
      category: "TRANSIENT_FAILURE",
      message: "Provider validation request timed out. Please verify connectivity and try again.",
    };
  }

  // 2. Check for definitive authentication failures
  if (isGeminiAuthenticationError(error)) {
    return {
      category: "AUTH_FAILURE",
      message: "API key was rejected by Google. Please check that the key is valid and not expired.",
    };
  }

  const errObj = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const status = Number(
    errObj.status ??
      errObj.statusCode ??
      (errObj.response as Record<string, unknown> | undefined)?.status
  );

  const details = extractGeminiErrorDetails(errObj);
  const reasons = details.map((d) => d.reason);

  // 3. Quota / Rate Limiting
  if (
    status === 429 ||
    reasons.includes("RESOURCE_EXHAUSTED") ||
    reasons.includes("RATE_LIMIT_EXCEEDED") ||
    reasons.includes("QUOTA_EXCEEDED") ||
    /quota|resource_exhausted|rate\s*limit/i.test(rawMsg)
  ) {
    return {
      category: "QUOTA_EXHAUSTED",
      message: "API key quota or rate limit exceeded on Google Cloud.",
    };
  }

  // 4. Permission Denied (e.g. model not enabled or restricted key)
  if (
    status === 403 ||
    reasons.includes("PERMISSION_DENIED") ||
    /permission_denied|caller does not have permission/i.test(rawMsg)
  ) {
    return {
      category: "PERMISSION_DENIED",
      message: "API key does not have permission for the requested Gemini model.",
    };
  }

  // 5. Transient Server Errors (5xx)
  if (status >= 500 || /internal|temporarily unavailable|service unavailable/i.test(rawMsg)) {
    return {
      category: "TRANSIENT_FAILURE",
      message: "Google Gemini returned a temporary server error (HTTP " + (status || 500) + ").",
    };
  }

  // 6. Model Not Found / Retired (404)
  if (status === 404 || /not\s*found|is not found for API version|unsupported model/i.test(rawMsg)) {
    return {
      category: "INVALID_REQUEST",
      message: `Configured model is retired or not found on provider: ${sanitizedMsg}`,
    };
  }

  return {
    category: "INVALID_REQUEST",
    message: sanitizedMsg || "Failed to validate credential with provider.",
  };
}

/**
 * Validates a Gemini API key using bounded, minimal test calls.
 * - GENERATION: Calls gemini-3.6-flash with a minimal 'ping' prompt.
 * - EMBEDDING: Calls gemini-embedding-001 with a minimal 'ping' value.
 *
 * Enforces a strict timeout (default 5000ms).
 * Never mutates any database records or global singletons.
 */
export async function validateGeminiKey(
  options: ValidateKeyOptions
): Promise<KeyValidationResult> {
  const { apiKey, purpose, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return {
      valid: false,
      category: "AUTH_FAILURE",
      message: "API key cannot be empty.",
      testedModel: "none",
      latencyMs: 0,
    };
  }

  const trimmedKey = apiKey.trim();
  const startTime = Date.now();
  const client = new GoogleGenerativeAI(trimmedKey);

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`VALIDATION_TIMEOUT: Bounded check exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  const testedModel =
    purpose === CredentialPurpose.EMBEDDING
      ? VALIDATION_MODELS.EMBEDDING
      : VALIDATION_MODELS.GENERATION;

  try {
    if (purpose === CredentialPurpose.EMBEDDING) {
      const model = client.getGenerativeModel({ model: testedModel });
      await Promise.race([
        model.embedContent("ping"),
        timeoutPromise,
      ]);
    } else {
      const model = client.getGenerativeModel({ model: testedModel });
      await Promise.race([
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
        timeoutPromise,
      ]);
    }

    if (timer) clearTimeout(timer);
    const latencyMs = Date.now() - startTime;

    return {
      valid: true,
      category: "VALID",
      message: "API key successfully validated with Google Gemini.",
      testedModel,
      latencyMs,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const latencyMs = Date.now() - startTime;
    const classified = classifyGeminiValidationError(err);

    return {
      valid: false,
      category: classified.category,
      message: classified.message,
      testedModel,
      latencyMs,
    };
  }
}
