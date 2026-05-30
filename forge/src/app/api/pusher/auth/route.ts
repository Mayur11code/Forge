// src/app/api/pusher/auth/route.ts
import { NextRequest, NextResponse } from "next/server";
import { pusherServer } from "@/lib/pusher/pusher-server"; 

export async function POST(req: NextRequest) {
  // In a real app, you would check your auth session here (e.g., Clerk, NextAuth)
  // const user = await currentUser();
  // if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const data = await req.text();
  const [socketId, channelName] = data.split("&").map((str) => str.split("=")[1]);

  // This generates a cryptographic signature proving your server authorized this user
  const authResponse = pusherServer.authorizeChannel(socketId, channelName);
  
  return NextResponse.json(authResponse);
}