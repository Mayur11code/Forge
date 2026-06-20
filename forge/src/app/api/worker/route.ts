import { NextRequest, NextResponse } from "next/server";
import { createWorker } from "@/lib/events/worker";


import { fileWorkerHandler } from "@/app/api/worker/file-worker/fw";
import { emailWorkerHandler } from "@/app/api/worker/email-worker/ew";
import { aiWorkerHandler } from "@/app/api/worker/ai-worker/ai-worker";
import { cronWorkerHandler } from "@/app/api/worker/cron-worker/cw";
import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";


const handleFileUpload = createWorker("FILE_UPLOADED", fileWorkerHandler);
const handleEmail = createWorker("SEND_EMAIL", emailWorkerHandler);
const handleCron = createWorker("CRON_DAILY_DIGEST", cronWorkerHandler);
const handleAI = createWorker("EMBEDDING_REQUESTED", aiWorkerHandler);
// 2. Create the CDC Workers routing to the single Idempotent handler
const handleTaskCreated = createWorker("TASK_CREATED", embeddingWorkerHandler);
const handleTaskUpdated = createWorker("TASK_UPDATED", embeddingWorkerHandler);
const handleTaskDeleted = createWorker("TASK_DELETED", embeddingWorkerHandler);

export async function POST(req: NextRequest) {
  try {
    const clonedReq = req.clone();
    const body = await clonedReq.json();
    const { type } = body;
 
    console.log(`[WORKER] Event received: ${type}`);
 

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

  case "TASK_CREATED":
        return await handleTaskCreated(req);
      case "TASK_UPDATED":
        return await handleTaskUpdated(req);
      case "TASK_DELETED":
        return await handleTaskDeleted(req);

      default:
        console.log(`⚠️ No handler configured for event: ${type}`);
        return NextResponse.json({ ok: true });
    }

  } catch (error: any) {
    console.error("❌ ROUTER FATAL ERROR:", error);
    return NextResponse.json({ error: "Router failed" }, { status: 500 });
  }
}