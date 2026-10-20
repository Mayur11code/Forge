//THIS HANDLES THE UI SIDE OF THE PAYMENT
import { NextResponse } from "next/server";
import Razorpay from "razorpay";
import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// S2 (security) — AUTHENTICATE AND AUTHORIZE.
//
// This route used to accept an unauthenticated POST and stamp the caller's
// `orgId` into the Razorpay subscription `notes`. The webhook then trusts that
// note verbatim, so an attacker who could reach this endpoint could bind any
// organization's billing record to a subscription they created. The org must be
// resolved against the session and require ADMIN membership before any
// subscription is created.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { orgId } = await req.json();

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId is required" },
        { status: 400 }
      );
    }

    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { role: true },
    });

    if (!membership || membership.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: process.env.RAZORPAY_PLAN_ID!,
      total_count: 12,
      customer_notify: 1,
      notes: {
        orgId,
      },
    });

    return NextResponse.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID!,
    });
  } catch (error) {
    console.error("Create subscription failed:", error);
    return NextResponse.json(
      { error: "Failed to create subscription" },
      { status: 500 }
    );
  }
}