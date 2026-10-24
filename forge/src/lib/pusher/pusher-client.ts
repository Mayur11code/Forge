import PusherClient from "pusher-js";
import { getClientEnv } from "@/lib/env/client";

export const getPusherClient = () => {
  // Ensure this only runs in the browser, not on the Next.js server
  if (typeof window === "undefined") return null;

  const { NEXT_PUBLIC_PUSHER_KEY, NEXT_PUBLIC_PUSHER_CLUSTER } = getClientEnv();

  return new PusherClient(NEXT_PUBLIC_PUSHER_KEY!, {
    cluster: NEXT_PUBLIC_PUSHER_CLUSTER!,
    authEndpoint: "/api/pusher/auth",
  });
};
