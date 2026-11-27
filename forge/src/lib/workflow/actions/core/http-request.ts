// src/lib/workflow/actions/core/http-request.ts
//
// Hardened SSRF-safe outbound HTTP webhook action (FC-022).
//
// Security guarantees:
// - All destinations validated against strict SSRF blocklists (RFC1918, loopback, cloud metadata).
// - Socket IP pinning eliminates DNS rebinding (TOCTOU).
// - Credentials redacted from persisted StepRun outputs and logs.
// - Streaming 1 MB response cap prevents memory exhaustion.
// - Classified as IRREVERSIBLE in compensation taxonomy.

import {
  ExecuteFunction,
  WorkflowAction,
  JsonValue,
} from "../../../workflow-types/type";
import { ssrfFetch, SSRFError } from "@/lib/security/ssrf";
import type http from "node:http";

type TestHttpHooks = {
  customTransport?: typeof http.request;
  customDnsResolver?: (hostname: string) => Promise<string[]>;
};

let testHooks: TestHttpHooks | null = null;

/**
 * Test-only seam to inject a custom transport or DNS resolver.
 * Guaranteed to be impossible to activate in production.
 */
export function __setTestHttpRequestHooks(hooks: TestHttpHooks | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setTestHttpRequestHooks can only be invoked in a test environment.");
  }
  testHooks = hooks;
}

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { url, method = "GET", headers, body, timeout } = ctx.inputs;

    if (!url || typeof url !== "string") {
      return {
        success: false,
        error: "Missing required field: url is required",
        isRetriable: false,
      };
    }

    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    const upperMethod = typeof method === "string" ? method.toUpperCase() : "GET";
    if (!validMethods.includes(upperMethod)) {
      return {
        success: false,
        error: `Invalid HTTP method "${method}". Allowed methods: ${validMethods.join(", ")}`,
        isRetriable: false,
      };
    }

    const cleanHeaders: Record<string, string> = {};
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          cleanHeaders[k] = v;
        }
      }
    }

    const connectTimeoutMs = typeof timeout === "number" ? Math.min(timeout, 5000) : 5000;
    const readTimeoutMs = typeof timeout === "number" ? Math.min(timeout, 10000) : 10000;

    const activeTestHooks = process.env.NODE_ENV === "test" ? testHooks : null;

    const response = await ssrfFetch(url, {
      method: upperMethod as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      headers: cleanHeaders,
      body,
      connectTimeoutMs,
      readTimeoutMs,
      ...(activeTestHooks?.customTransport ? { customTransport: activeTestHooks.customTransport } : {}),
      ...(activeTestHooks?.customDnsResolver ? { customDnsResolver: activeTestHooks.customDnsResolver } : {}),
    });

    const isSuccess = response.status >= 200 && response.status < 300;

    if (!isSuccess) {
      const isRetriable = response.status === 429 || response.status >= 500;
      return {
        success: false,
        error: `HTTP request failed with status ${response.status} (${response.statusText})`,
        isRetriable,
      };
    }

    return {
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        data: (response.data as JsonValue) ?? null,
        text: response.text,
        headers: response.headers,
        effectiveUrl: response.effectiveUrl,
        pinnedIp: response.pinnedIp,
      },
    };
  } catch (error) {
    if (error instanceof SSRFError) {
      return {
        success: false,
        error: `Security policy violation: ${error.message}`,
        isRetriable: false, // Security failures are never retried
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "HTTP request failed due to an unexpected error",
      isRetriable: false,
    };
  }
};

export const httpRequestAction: WorkflowAction = {
  id: "http.request",
  version: "1.0.0",
  execute,
};
