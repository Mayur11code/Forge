import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/prisma/db";

export async function POST(req: Request) {
  try {
    const body = await req.text(); // MUST be raw
    const signature = req.headers.get("x-razorpay-signature");

    if (!signature) {
      return new NextResponse("Missing signature", { status: 400 });
    }

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Missing RAZORPAY_WEBHOOK_SECRET");
      return new NextResponse("Configuration error", { status: 500 });
    }

    // 🔐 1. Verify Cryptographic Signature
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // S6 (security) — constant-time comparison. The digest is fixed-length hex,
    // so a length check followed by `timingSafeEqual` on buffers avoids leaking
    // information through the comparison of this billing write path's sole
    // authentication gate.
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const signatureBuffer = Buffer.from(signature, "utf8");
    const signatureValid =
      expectedBuffer.length === signatureBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

    if (!signatureValid) {
      console.error("❌ Invalid signature detected");
      return new NextResponse("Invalid signature", { status: 400 });
    }

    // ✅ 2. Parse Event
    const event = JSON.parse(body);
    const eventType = event.event;
    
   // Extract the entity ID based on the event type
// For subscriptions, it's in payload.subscription.entity.id
const entityId = event.payload?.subscription?.entity?.id || 
                 event.payload?.payment?.entity?.id || 
                 "unknown";

// 🚨 FIX: Razorpay doesn't always provide a top-level event.id. 
// We create a "Synthetic ID" to ensure we don't process the SAME event twice.
const eventId = event.id || `${eventType}_${entityId}_${event.created_at}`;

    console.log(`📩 Processing Razorpay Event: ${eventType} (${eventId})`);

    // 🛑 3. ATOMIC LOCK: Prevent TOCTOU Race Conditions
    try {
      await db.razorpayEvent.create({
        data: { id: eventId },
      });
    } catch (error: unknown) {
      // P2002 is Prisma's "Unique Constraint Violation" error code. Narrowed rather
      // than typed `any`: only that code means "already processed", and treating
      // every throw as a duplicate would silently swallow real database failures
      // as if they were replays.
      if ((error as { code?: unknown } | null)?.code === "P2002") {
        console.log(`⏭️ Skipping duplicate event: ${eventId}`);
        // We return 200 OK so Razorpay knows we received it and stops retrying
        return new NextResponse("Duplicate", { status: 200 }); 
      }
      throw error; // Re-throw if it's a real database connection issue
    }

    // 🚀 4. BUSINESS LOGIC
    switch (eventType) {
      case "subscription.activated":
      case "subscription.authenticated": {
        const sub = event.payload.subscription.entity;
        const orgId = sub.notes?.orgId;

        if (!orgId) {
          console.warn("⚠️ No orgId in metadata. Cannot assign subscription.");
          break; // Break safely, returning 200 OK below
        }

        // S2 (security) — defense-in-depth. The `orgId` note originates from
        // `create-order`, which now requires ADMIN auth; this second check stops
        // a malformed or otherwise-unexpected note from reaching a write with a
        // nonexistent id. `update` would throw P2025 for a missing row and bounce
        // the webhook into a 500 retry loop, so resolve first and skip cleanly.
        const targetOrg = await db.organization.findUnique({
          where: { id: orgId },
          select: { id: true },
        });

        if (!targetOrg) {
          console.warn("⚠️ Subscription references an unknown organization.");
          break;
        }

        await db.organization.update({
          where: { id: orgId },
          data: {
            razorpaySubscriptionId: sub.id,
            razorpayCustomerId: sub.customer_id,
            subscriptionStatus: sub.status,
            // Convert Razorpay's UNIX timestamp (seconds) to JS Date (milliseconds)
            currentPeriodEnd: new Date(sub.current_end * 1000), 
          },
        });

        console.log(`✅ Org ${orgId} subscription updated to ${sub.status}`);
        break;
      }

      case "subscription.charged": {
        console.log("💰 Subscription renewed/charged");
        // Add ledger or invoice logic here later
        break;
      }

      default:
        console.log(`🤷‍♂️ Unhandled event type: ${eventType}`);
    }

    // Acknowledge the webhook so Razorpay doesn't retry
    return new NextResponse("OK", { status: 200 });

  } catch (err) {
    console.error("❌ Webhook processing failed:", err);
    // Returning 500 tells Razorpay: "We crashed, please retry this webhook later."
    return new NextResponse("Internal error", { status: 500 });
  }
}