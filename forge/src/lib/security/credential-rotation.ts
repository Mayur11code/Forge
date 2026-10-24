import "server-only";

/**
 * Supported providers for zero-downtime credential rotation.
 */
export type RotationProvider = "gemini" | "pinecone" | "qstash";

/**
 * Structured payload for credential rotation failover events.
 * Strict invariant: Credential secrets/values must NEVER be passed or logged.
 */
export interface CredentialRotationLogEvent {
  provider: RotationProvider;
  subsystem: string;
  slot: "primary" | "fallback";
  operation: string;
  errorCategory: "AUTH_FAILURE_FAILOVER" | "FALLBACK_EXHAUSTED" | "DUAL_KEY_VERIFICATION";
  message?: string;
}

/**
 * Redacts any potential API keys, auth headers, or token patterns from error diagnostics.
 */
export function redactSecretPatterns(text: string): string {
  if (!text) return text;
  return text
    // Google API Keys
    .replace(/AIza[0-9A-Za-z\-_]{25,50}/g, "[REDACTED_GEMINI_KEY]")
    // Authorization Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED_TOKEN]")
    // Pinecone API keys
    .replace(/pcsk_[0-9A-Za-z\-_]+/g, "[REDACTED_PINECONE_KEY]")
    // Generic API Key assignments
    .replace(/(api[_-]?key|token|secret)[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/gi, "$1=[REDACTED]");
}

/**
 * Emits a structured security audit warning when a credential failover occurs.
 * Safe for production observability pipelines; guaranteed not to disclose secrets.
 */
export function logCredentialFailover(event: CredentialRotationLogEvent): void {
  const sanitizedMessage = event.message ? redactSecretPatterns(event.message) : undefined;
  
  console.warn(
    `[CREDENTIAL_ROTATION] [${event.provider.toUpperCase()}] [${event.subsystem}] Failover event: ` +
      JSON.stringify({
        provider: event.provider,
        subsystem: event.subsystem,
        slot: event.slot,
        operation: event.operation,
        errorCategory: event.errorCategory,
        message: sanitizedMessage,
        timestamp: new Date().toISOString(),
      })
  );
}

/**
 * Definitively non-retryable errors from Google APIs.
 * These represent project state, permissions, billing, rate limits, or account status
 * that CANNOT be resolved by switching to a fallback API key.
 * Under no circumstances should these trigger credential failover.
 */
const NON_RETRYABLE_GEMINI_REASONS = new Set([
  "CONSUMER_INVALID",
  "SERVICE_DISABLED",
  "BILLING_DISABLED",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "QUOTA_EXCEEDED",
  "ACCESS_TOKEN_EXPIRED",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "LOCATION_NOT_SUPPORTED",
  "USER_LOCATION_BLOCKED",
]);

/**
 * Structured Google RPC ErrorInfo shape.
 */
export interface GeminiErrorInfo {
  reason: string;
  domain?: string;
  metadata?: Record<string, string>;
}

/**
 * The target Google Cloud service for Forge's Gemini integration.
 */
export const FORGE_GEMINI_SERVICE = "generativelanguage.googleapis.com";

/**
 * Extracts structured Google RPC ErrorInfo objects from error objects.
 * Handles both @google/generative-ai (GoogleGenerativeAIFetchError.errorDetails)
 * and @ai-sdk/google (APICallError.data.error.details / responseBody).
 */
export function extractGeminiErrorDetails(err: Record<string, unknown>): GeminiErrorInfo[] {
  const details: GeminiErrorInfo[] = [];

  const addDetail = (raw: unknown) => {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.reason === "string") {
        details.push({
          reason: obj.reason,
          domain: typeof obj.domain === "string" ? obj.domain : undefined,
          metadata:
            obj.metadata && typeof obj.metadata === "object"
              ? (obj.metadata as Record<string, string>)
              : undefined,
        });
      }
    }
  };

  // 1. Check errorDetails array (GoogleGenerativeAIFetchError shape)
  if (Array.isArray(err.errorDetails)) {
    for (const d of err.errorDetails) {
      addDetail(d);
    }
  }

  // 2. Check err.data?.error?.details (APICallError shape from AI SDK)
  const data = err.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const errorObj = data.error as Record<string, unknown> | undefined;
    if (errorObj && typeof errorObj === "object" && Array.isArray(errorObj.details)) {
      for (const d of errorObj.details) {
        addDetail(d);
      }
    }
  }

  // 3. Check err.response?.data?.error?.details
  const responseObj = err.response as Record<string, unknown> | undefined;
  if (responseObj && typeof responseObj === "object") {
    const respData = responseObj.data as Record<string, unknown> | undefined;
    if (respData && typeof respData === "object") {
      const errorObj = respData.error as Record<string, unknown> | undefined;
      if (errorObj && typeof errorObj === "object" && Array.isArray(errorObj.details)) {
        for (const d of errorObj.details) {
          addDetail(d);
        }
      }
    }
  }

  // 4. Check responseBody raw string if present (AI SDK APICallError preserves full responseBody)
  if (typeof err.responseBody === "string") {
    try {
      const parsed = JSON.parse(err.responseBody);
      if (parsed?.error?.details && Array.isArray(parsed.error.details)) {
        for (const d of parsed.error.details) {
          addDetail(d);
        }
      }
    } catch {
      // ignore json parse error
    }
  }

  return details;
}

/**
 * Extracts structured Google RPC ErrorInfo reasons from error objects.
 */
export function extractGeminiErrorReasons(err: Record<string, unknown>): string[] {
  return extractGeminiErrorDetails(err).map((d) => d.reason);
}

/**
 * Evaluates whether an error from Google Gemini / @ai-sdk/google indicates
 * a definitive authentication/credential invalidity failure rather than transient network,
 * rate limit, model invocation, permission, project, or billing issues.
 *
 * Auth failure indicators:
 * - Structured Google RPC ErrorInfo with reason API_KEY_INVALID, API_KEY_EXPIRED,
 *   API_KEY_NOT_FOUND, or API_KEY_SERVICE_BLOCKED targeting generativelanguage.googleapis.com.
 * - Explicit API key failure message emitted by Google API endpoints.
 * - HTTP 401 with UNAUTHENTICATED or missing/invalid credential status.
 *
 * Non-auth issues (which MUST NOT trigger failover):
 * - HTTP 429 (quota exhaustion / rate limiting / RESOURCE_EXHAUSTED)
 * - HTTP 5xx (transient backend unavailable)
 * - Generic HTTP 403 PERMISSION_DENIED (IAM permissions, model access)
 * - Project or consumer failures (CONSUMER_INVALID, SERVICE_DISABLED, BILLING_DISABLED)
 * - Key restrictions for unrelated services (metadata.service !== generativelanguage.googleapis.com)
 * - Network aborts, timeouts, socket resets
 * - Unrecognized HTTP 400 or 403 errors
 * - Model validation errors (safety block, prompt schema invalid)
 */
export function isGeminiAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const status = Number(
    err.status ??
      err.statusCode ??
      (err.response as Record<string, unknown> | undefined)?.status
  );

  // 1. Fast-path exclusions by HTTP status
  if (status === 429) return false;
  if (status >= 500) return false;

  // 2. Structured Detail Evaluation
  const details = extractGeminiErrorDetails(err);
  const reasons = details.map((d) => d.reason);

  // If any structured reason is explicitly non-retryable (e.g. CONSUMER_INVALID, BILLING_DISABLED), reject failover
  if (reasons.some((r) => NON_RETRYABLE_GEMINI_REASONS.has(r))) {
    return false;
  }

  // Evaluate credential-specific reasons with service context
  for (const detail of details) {
    // Universal API key invalidity / expiration / deletion
    if (
      detail.reason === "API_KEY_INVALID" ||
      detail.reason === "API_KEY_EXPIRED" ||
      detail.reason === "API_KEY_NOT_FOUND"
    ) {
      return true;
    }

    // Key restriction on service or network endpoint
    if (
      detail.reason === "API_KEY_SERVICE_BLOCKED" ||
      detail.reason === "API_KEY_HTTP_REFERRER_BLOCKED" ||
      detail.reason === "API_KEY_IP_ADDRESS_BLOCKED"
    ) {
      // If service metadata is present, it MUST match Forge's target Gemini service
      const targetService = detail.metadata?.service;
      if (targetService && targetService !== FORGE_GEMINI_SERVICE) {
        // Restriction applies to an unrelated service (e.g. maps, storage); do not failover
        continue;
      }
      return true;
    }
  }

  // 3. Status string check
  const data = err.data as Record<string, unknown> | undefined;
  const respObj = err.response as Record<string, unknown> | undefined;
  const respData = respObj?.data as Record<string, unknown> | undefined;
  const errorObj = (data?.error ?? respData?.error) as Record<string, unknown> | undefined;
  const rpcStatus = String(errorObj?.status ?? err.statusText ?? "").toUpperCase();

  const message = String(err.message || "");
  const lowerMsg = message.toLowerCase();

  // 4. Strict check for HTTP 403 / PERMISSION_DENIED
  // Generic PERMISSION_DENIED must NEVER trigger failover unless there is positive API key proof
  if (rpcStatus === "PERMISSION_DENIED" || status === 403) {
    if (
      lowerMsg.includes("api key not valid") ||
      lowerMsg.includes("api key expired") ||
      lowerMsg.includes("api_key_invalid")
    ) {
      return true;
    }
    return false;
  }

  // 5. Exclude non-auth indicators in message
  if (
    lowerMsg.includes("resource_exhausted") ||
    lowerMsg.includes("quota exceeded") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("billing") ||
    lowerMsg.includes("consumer_invalid") ||
    lowerMsg.includes("service_disabled") ||
    lowerMsg.includes("permission_denied") ||
    lowerMsg.includes("caller does not have permission") ||
    lowerMsg.includes("safety") ||
    lowerMsg.includes("blocked due to safety")
  ) {
    return false;
  }

  // 6. Definitive API key error phrases emitted by Google Gemini endpoints
  if (
    /\bapi[_-]?key\b.*?\b(not\s+valid|invalid|expired|not\s+found)\b/i.test(message) ||
    /\b(invalid|expired)\b.*?\bapi[_-]?key\b/i.test(message) ||
    lowerMsg.includes("api key not valid") ||
    lowerMsg.includes("api key expired") ||
    lowerMsg.includes("api_key_invalid") ||
    lowerMsg.includes("api_key_expired")
  ) {
    return true;
  }

  // 7. Explicit HTTP 401 UNAUTHENTICATED
  if (status === 401) {
    if (
      rpcStatus === "UNAUTHENTICATED" ||
      lowerMsg.includes("unauthenticated") ||
      lowerMsg.includes("credential") ||
      lowerMsg.includes("api key")
    ) {
      return true;
    }
  }

  // Unrecognized 400, 403, or any other code without positive API key proof defaults to fail-closed
  return false;
}

/**
 * Evaluates whether an error from Pinecone indicates a definitive API key authentication failure
 * (e.g. PineconeAuthorizationError, HTTP 401 Unauthorized with API key rejection)
 * rather than insufficient permissions (403), index/namespace not found (404),
 * conflict (409), rate limits (429), or server errors (5xx).
 */
export function isPineconeAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const status = Number(
    err.status ??
      err.statusCode ??
      (err.response as Record<string, unknown> | undefined)?.status
  );

  // Fast exclusion of non-auth HTTP status codes
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 429 || status >= 500) {
    return false;
  }

  // PineconeAuthorizationError is strictly thrown on HTTP 401 by the Pinecone SDK
  if (err.name === "PineconeAuthorizationError" || (err.constructor && err.constructor.name === "PineconeAuthorizationError")) {
    return true;
  }

  const message = String(err.message || "");
  const lowerMessage = message.toLowerCase();

  // Exclude quota, rate-limit, permissions, and timeout messages
  if (
    lowerMessage.includes("quota") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("permission") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("not found")
  ) {
    return false;
  }

  // Definitive Pinecone API key rejection signatures
  if (
    status === 401 &&
    (lowerMessage.includes("api key") ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("pineconeauthorizationerror"))
  ) {
    return true;
  }

  // Explicit message signature matching PineconeAuthorizationError constructor
  if (
    lowerMessage.includes("the api key you provided was rejected") ||
    lowerMessage.includes("pineconeauthorizationerror") ||
    /\bapi[_-]?key\b.*?\b(rejected|invalid|unauthorized)\b/i.test(message)
  ) {
    return true;
  }

  return false;
}
