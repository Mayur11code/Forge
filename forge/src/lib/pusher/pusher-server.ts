import Pusher from "pusher";

// We use global to prevent multiple instances during Next.js hot-reloading in dev
const globalForPusher = global as unknown as { pusherServer: Pusher };

export const pusherServer =
  globalForPusher.pusherServer ||
  new Pusher({
    appId: process.env.PUSHER_APP_ID!,
    key: process.env.NEXT_PUBLIC_PUSHER_KEY!,
    secret: process.env.PUSHER_SECRET!,
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
    useTLS: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPusher.pusherServer = pusherServer;
}