"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function UpgradeButton({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);
  }, []);

  const handleUpgrade = async () => {
    try {
      setLoading(true);

      const res = await fetch("/api/razerpay/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start subscription");
      }

      const options = {
        key: data.keyId,
        subscription_id: data.subscriptionId,
        name: "Engineered Forge",
        description: "Pro Subscription",
        handler: function (response: any) {
          console.log("Payment success callback:", response);
          // Do NOT mark paid here.
          // Webhook is the source of truth.
        },
        prefill: {},
        notes: {
          orgId,
        },
        theme: {
          color: "#111827",
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (error) {
      console.error(error);
      alert("Could not start subscription");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleUpgrade}
      disabled={loading}
      className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50"
    >
      {loading ? "Starting..." : "Upgrade to Pro"}
    </button>
  );
}