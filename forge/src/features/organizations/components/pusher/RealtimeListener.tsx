"use client";

import { useEffect } from "react";
import { getPusherClient } from "@/lib/pusher/pusher-client";
import { organizationChannelName } from "@/lib/pusher/org-channel";
import { toast } from "sonner"; // or whatever toast library you use

export function RealtimeListener({
  organizationId,
}: {
  organizationId: string;
}) {
  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;

    const channelName = organizationChannelName(organizationId);
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
  }, [organizationId]);

  return null; // This component doesn't render anything visually
}