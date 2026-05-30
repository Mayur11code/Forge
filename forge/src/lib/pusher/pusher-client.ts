import PusherClient from "pusher-js";

export const getPusherClient = () => {
  // Ensure this only runs in the browser, not on the Next.js server
  if (typeof window === "undefined") return null;

  return new PusherClient(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
    
      authEndpoint: "/api/pusher/auth",
  });
};