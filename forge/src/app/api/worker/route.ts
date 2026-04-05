import { NextRequest, NextResponse } from "next/server";
import { createWorker } from "@/lib/events/worker";

// Import your wrapped workers
import { fileWorkerHandler } from "@/app/api/worker/file-worker/fw";
import { emailWorkerHandler } from "@/app/api/worker/email-worker/ew";
import { aiWorkerHandler } from "@/app/api/worker/ai-worker/ai-worker";
import { cronWorkerHandler } from "@/app/api/worker/cron-worker/cw";

import { rateLimit } from "@/lib/redis/rate-limit";

const handleFileUpload = createWorker("FILE_UPLOADED", fileWorkerHandler);
const handleEmail = createWorker("SEND_EMAIL", emailWorkerHandler);
const handleCron = createWorker("CRON_DAILY_DIGEST", cronWorkerHandler);
const handleAI = createWorker("EMBEDDING_REQUESTED", aiWorkerHandler);

export async function POST(req: NextRequest) {
  try {
    const clonedReq = req.clone();
    const body = await clonedReq.json();
    const { id, type, data, time } = body;
    const ip =
      req.headers.get("x-forwarded-for") ||
      req.headers.get("x-real-ip") ||
      "unknown";
    console.log(`🚀 [WORKER] Event received: ${type}`);
    // 2️⃣ RATE LIMIT CHECK
    // const { success } = await rateLimit.limit(`worker_${ip}`);

    // // 3️⃣ BLOCK IF EXCEEDED
    // if (!success) {
    //   console.warn(`[RATE LIMIT] Worker blocked for IP: ${ip}`);
    //   return new Response("Too Many Requests", { status: 429 });
    // }


    if (!type) {
      return NextResponse.json({ error: "Missing event type" }, { status: 400 });
    }



    // -----------------------------
    // MAIN DISPATCHER
    // -----------------------------
    switch (type) {
      case "FILE_UPLOADED":

        return await handleFileUpload(req);

      case "SEND_EMAIL":
        return await handleEmail(req);

      case "EMBEDDING_REQUESTED":
        return await handleAI(req);

      case "CRON_DAILY_DIGEST":
  return await handleCron(req);

      default:
        console.log(`⚠️ No handler configured for event: ${type}`);
        return NextResponse.json({ ok: true });
    }

  } catch (error: any) {
    console.error("❌ ROUTER FATAL ERROR:", error);
    return NextResponse.json({ error: "Router failed" }, { status: 500 });
  }
}