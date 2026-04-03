import { NextRequest, NextResponse } from "next/server";
import { createWorker } from "@/lib/events/worker";

// Import your wrapped workers
import { fileWorkerHandler } from "@/app/api/worker/file-worker/route";
import { emailWorkerHandler } from "@/app/api/worker/email-worker/route";
import { aiWorkerHandler } from "@/app/api/worker/ai-worker/route";



const handleFileUpload = createWorker("FILE_UPLOADED", fileWorkerHandler);
const handleEmail = createWorker("SEND_EMAIL", emailWorkerHandler);
const handleAI = createWorker("EMBEDDING_REQUESTED", aiWorkerHandler);

export async function POST(req: NextRequest) {
  try {
    const clonedReq = req.clone();
    const body = await clonedReq.json();
    const { id, type, data, time } = body;

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

      default:
        console.log(`⚠️ No handler configured for event: ${type}`);
        return NextResponse.json({ ok: true });
    }

  } catch (error: any) {
    console.error("❌ ROUTER FATAL ERROR:", error);
    return NextResponse.json({ error: "Router failed" }, { status: 500 });
  }
}