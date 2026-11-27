// src/app/api/cron/domain-outbox/route.ts
//
// M4-REM-3: Standing Production Outbox Sweeper Route Handler.
//
// Invariant: Committed eligible DomainEventOutbox records are recovered periodically
// even if the initial post-commit fast-path QStash notification failed.
//
// Security & Execution Semantics:
// 1. Authenticated via CRON_SECRET using constant-time crypto comparison.
// 2. Supports both GET (standard deployment cron, e.g. Vercel Cron) and POST (QStash schedule).
// 3. Claims pending eligible events with token-fenced concurrency (SKIP LOCKED).
// 4. Returns structured telemetry for monitoring without exposing PII.

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { processDomainEventOutbox } from "@/lib/workflow/execution/event-dispatcher";
import { getDomainOutboxTelemetry } from "@/lib/events/domain-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Constant-time authentication helper for cron secrets.
 */
function isCronAuthorized(req: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret || configuredSecret.length === 0) {
    // In local dev without secret configured, reject unless strictly in non-production development mode
    if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
      return true;
    }
    return false;
  }

  // Extract from Authorization header (Bearer token) or x-cron-secret header
  const authHeader = req.headers.get("authorization") || "";
  const headerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : req.headers.get("x-cron-secret") || "";

  if (!headerToken || headerToken.length !== configuredSecret.length) {
    return false;
  }

  try {
    const a = Buffer.from(headerToken, "utf8");
    const b = Buffer.from(configuredSecret, "utf8");
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handleSweep(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  // Parse batch size (default 25, clamped 1-100)
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 25;
  const batchSize = Math.max(1, Math.min(Number.isNaN(parsedLimit) ? 25 : parsedLimit, 100));

  const startTime = Date.now();
  const result = await processDomainEventOutbox(batchSize);
  const telemetry = await getDomainOutboxTelemetry();
  const durationMs = Date.now() - startTime;

  console.log(
    `[OUTBOX_SWEEPER] tick: processed=${result.processed}, success=${result.successCount}, failure=${result.failureCount}, pendingBacklog=${telemetry.pendingEligibleCount}, oldestAgeSec=${telemetry.oldestPendingAgeSec ?? 0}, durationMs=${durationMs}`,
  );

  return NextResponse.json({
    ok: true,
    processed: result.processed,
    successCount: result.successCount,
    failureCount: result.failureCount,
    durationMs,
    telemetry,
  });
}

export async function GET(req: NextRequest) {
  return handleSweep(req);
}

export async function POST(req: NextRequest) {
  return handleSweep(req);
}
