// src/app/api/pusher/auth/route.ts
//
// Pusher private-channel authorization.
//
// SECURITY: this endpoint must never authorize a subscription based on the
// request body alone. The client sends `channel_name`, and the session id is
// embedded in that string, so trusting it would let any authenticated user
// subscribe to any other user's agent stream by guessing an id.
//
// Flow:
//   auth()  ->  parse  ->  validate channel shape  ->  verify ownership
//         ->  authorizeChannel
//
// Ownership is delegated to the existing session service. Knowing a
// sessionId is not authorization: the persisted AgentSession.userId must match
// the authenticated caller.

import { NextRequest, NextResponse } from "next/server";

import { pusherServer } from "@/lib/pusher/pusher-server";
import { auth } from "@/lib/auth/auth";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import {
  extractAgentSessionId,
  parsePusherAuthBody,
} from "@/lib/pusher/agent-channel";

export async function POST(req: NextRequest) {
  const userId = (await auth())?.user?.id;

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const parsed = parsePusherAuthBody(await req.text());

  if (!parsed) {
    return NextResponse.json(
      { error: "Malformed authorization request" },
      { status: 400 },
    );
  }

  const { socketId, channelName } = parsed;

  // Only the agent session channel is authorizable. Anything else is refused
  // rather than signed.
  const sessionId = extractAgentSessionId(channelName);

  if (!sessionId) {
    return NextResponse.json(
      { error: "Channel is not authorizable" },
      { status: 403 },
    );
  }

  const session = await getAgentSessionForUser({ sessionId, userId });

  if (!session) {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  const authResponse = pusherServer.authorizeChannel(
    socketId,
    channelName,
  );

  return NextResponse.json(authResponse);
}
