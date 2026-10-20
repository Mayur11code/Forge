// src/tests/security/error-disclosure-and-webhook.test.ts
//
// S5 — persisted tool-execution error no longer leaks a stack to clients.
// S6 — Razorpay webhook signature comparison is constant-time.
// S2 (back) — the webhook refuses to write billing state for an unknown org.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organization: { findUnique: jest.fn(), update: jest.fn() },
    razorpayEvent: { create: jest.fn() },
  },
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: { agentToolExecution: { update: jest.fn() } },
}));

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { prisma } from "@/lib/prisma/extended";
import { failToolExecution } from "@/lib/ai/agent/services/tool-execution-service";

const organizationFindUnique = db.organization.findUnique as jest.Mock;
const organizationUpdate = db.organization.update as jest.Mock;
const razorpayEventCreate = db.razorpayEvent.create as jest.Mock;
const agentUpdate = prisma.agentToolExecution.update as jest.Mock;

const SECRET = "test_webhook_secret";

function sign(body: string, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});

// ---------------------------------------------------------------------------
// S5
// ---------------------------------------------------------------------------
describe("S5 failToolExecution persists the message, never the stack", () => {
  it("stores error.message and drops stack frames", async () => {
    agentUpdate.mockResolvedValue({ id: "exec_1" });

    const error = new Error("tool failed");
    error.stack = "Error: tool failed\n    at /app/secret/path.ts:42:9";

    await failToolExecution("exec_1", error);

    const written = agentUpdate.mock.calls[0][0].data.error as string;
    expect(written).toBe("tool failed");
    expect(written).not.toContain("/app/secret");
    expect(written).not.toContain("at ");
  });
});

// ---------------------------------------------------------------------------
// S6 + S2(back)
// ---------------------------------------------------------------------------
describe("Razorpay webhook signature and org binding", () => {
  async function webhook(body: string, signature: string | null) {
    const { POST } = await import("@/app/api/webhooks/razerpay/route");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (signature !== null) headers["x-razorpay-signature"] = signature;
    return POST(
      new Request("http://localhost/api/webhooks/razerpay", {
        method: "POST",
        headers,
        body,
      }),
    );
  }

  it("rejects a tampered signature with 400 and never locks or writes", async () => {
    const body = JSON.stringify({ event: "subscription.charged" });

    const res = await webhook(body, "deadbeef");

    expect(res.status).toBe(400);
    expect(razorpayEventCreate).not.toHaveBeenCalled();
    expect(organizationUpdate).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed event", async () => {
    const body = JSON.stringify({ event: "subscription.charged" });
    razorpayEventCreate.mockResolvedValue({});

    const res = await webhook(body, sign(body));

    expect(res.status).toBe(200);
    expect(razorpayEventCreate).toHaveBeenCalled();
  });

  it("refuses to update billing state for an unknown organization", async () => {
    const body = JSON.stringify({
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: {
            id: "sub_1",
            customer_id: "cust_1",
            status: "active",
            current_end: 1700000000,
            notes: { orgId: "org_does_not_exist" },
          },
        },
      },
    });
    razorpayEventCreate.mockResolvedValue({});
    organizationFindUnique.mockResolvedValue(null);

    const res = await webhook(body, sign(body));

    expect(res.status).toBe(200);
    expect(organizationUpdate).not.toHaveBeenCalled();
  });
});
