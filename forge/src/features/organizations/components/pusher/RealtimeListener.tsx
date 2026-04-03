"use client";

import { useEffect } from "react";
import { getPusherClient } from "@/lib/pusher/pusher-client";
import { toast } from "sonner"; // or whatever toast library you use

export function RealtimeListener({ orgId }: { orgId: string }) {
  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;

    const channelName = `org-${orgId}`;
    // 1. Subscribe to the isolated channel
    const channel = pusher.subscribe(channelName);

    // 2. Bind to the specific event
    channel.bind("job-completed", (data: { message: string, type: string }) => {
      console.log("Real-time event received!", data);
      
      // 3. Trigger the UI change
      toast.success(data.message, {
        description: `Job Type: ${data.type}`,
      });
    });

    // 4. Cleanup when the component unmounts
    return () => {
      channel.unbind_all();
      channel.unsubscribe();
    };
  }, [orgId]);

  return null; // This component doesn't render anything visually
}