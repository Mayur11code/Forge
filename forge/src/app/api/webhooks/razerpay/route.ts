import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/prisma/db";

export async function POST(req: Request) {
  const body = await req.text(); // MUST be raw
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature) {
    return new NextResponse("Missing signature", { status: 400 });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;

  // 🔐 Verify signature
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  if (expectedSignature !== signature) {
    console.error("❌ Invalid signature");
    return new NextResponse("Invalid signature", { status: 400 });
  }

  // ✅ Parse event
  const event = JSON.parse(body);

  console.log("📩 Razorpay Event:", event.event);
  const eventId = event.payload.subscription.entity.id;

const exists = await db.razorpayEvent.findUnique({
  where: { id: eventId },
});

if (exists) {
  return new Response("Duplicate", { status: 200 });
}

await db.razorpayEvent.create({
  data: { id: eventId },
});

  try {
    switch (event.event) {
      case "subscription.activated":
      case "subscription.authenticated": {
        const sub = event.payload.subscription.entity;

        const orgId = sub.notes?.orgId;

        if (!orgId) {
          console.warn("⚠️ No orgId in metadata");
          break;
        }

        await db.organization.update({
          where: { id: orgId },
          data: {
            razorpaySubscriptionId: sub.id,
            razorpayCustomerId: sub.customer_id,
            subscriptionStatus: sub.status,
            currentPeriodEnd: new Date(sub.current_end * 1000),
          },
        });

        console.log(`✅ Org ${orgId} subscription updated`);
        break;
      }

      case "subscription.charged": {
        console.log("💰 Subscription renewed");
        break;
      }

      default:
        console.log("Unhandled event:", event.event);
    }
  } catch (err) {
    console.error("❌ DB update failed:", err);
    return new NextResponse("Internal error", { status: 500 });
  }

  return new NextResponse("OK", { status: 200 });
}