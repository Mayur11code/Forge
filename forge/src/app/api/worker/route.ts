// import { NextRequest, NextResponse } from "next/server";
// import { verifySignatureAppRouter } from "@upstash/qstash/dist/nextjs";
// import { PrismaClient } from "@prisma/client";

// import { db } from "@/lib/prisma/db";

// // -----------------------------
// // CORE HANDLER
// // -----------------------------
// async function handler(req: NextRequest) {
//   let messageId: string | null = null;
//   // null = null because we want to explicitly set it to null if it's not
//   //  provided, so that we can check for it later in the catch block
//   //  when logging to the DLQ. If we left it as undefined, it would be harder to 
//   // check if it was set or not, and we might end up with an undefined value 
//   // in our database logs, which is less clear than having a null value that 
//   // explicitly indicates the absence of a messageId.

  
//   try {
//     const body = await req.json();
//     const { eventName, payload } = body;

//     messageId = req.headers.get("Upstash-Message-Id");

//     if (!messageId) {
//       return NextResponse.json(
//         { error: "Missing Message ID" },
//         { status: 400 }
//       );
//     }

//     // -----------------------------
//     // IDEMPOTENCY CHECK
//     // -----------------------------
//     const existingLog = await db.eventLog.findUnique({
//       where: { messageId },
//     });

//     if (existingLog) {
//       console.log(`⚠️ [Worker] Duplicate message skipped: ${messageId}`);
//       return NextResponse.json({ message: "Already processed" }, { status: 200 });
//     }

//     // -----------------------------
//     // CREATE EVENT LOG (PENDING)
//     // -----------------------------
//     await db.eventLog.create({
//       data: {
//         messageId,
//         eventName,
//         payload: payload || {},
//         status: "PENDING",
//       },
//     });

//     console.log("━━━━━━━━━━━━━━━━━━━━━━");
//     console.log(`⚙️ PROCESSING EVENT`);
//     console.log(`Event: ${eventName}`);
//     console.log(`Message ID: ${messageId}`);
//     console.log("━━━━━━━━━━━━━━━━━━━━━━");

//     // -----------------------------
//     // EVENT ROUTER
//     // -----------------------------
//     switch (eventName) {
//       case "TEST_EVENT":
//         await new Promise((resolve) => setTimeout(resolve, 2000));
//         console.log("✅ TEST EVENT PAYLOAD:", payload);
//         break;

//       default:
//         throw new Error(`Unknown event: ${eventName}`);
//     }

//     // -----------------------------
//     // MARK SUCCESS
//     // -----------------------------
//     await db.eventLog.update({
//       where: { messageId },
//       data: { status: "SUCCESS" },
//     });

//     console.log(`✅ EVENT SUCCESS: ${messageId}`);

//     return NextResponse.json({ success: true }, { status: 200 });

//   } catch (error: any) {
//     console.error("❌ WORKER ERROR:", error);

//     // -----------------------------
//     // DLQ LOGGING
//     // -----------------------------
//     if (messageId) {
//       await db.eventLog.update({
//         where: { messageId },
//         data: {
//           status: "FAILED",
//           error: error.message || "Unknown error",
//         },
//       }).catch(() => {});
//     }

//     return NextResponse.json({ error: "Job Failed" }, { status: 500 });
//   }
// }

// // -----------------------------
// // SECURITY WRAPPER (CRITICAL)
// // -----------------------------
// export const POST = verifySignatureAppRouter(handler);


// NOT USED ANYMORE, REFACTORED TO USE THE NEW WORKER FACTORY WITH BUILT IN IDEMPOTENCY AND SCHEMA VALIDATION