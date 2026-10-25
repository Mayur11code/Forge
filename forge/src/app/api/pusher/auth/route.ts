// src/app/api/pusher/auth/route.ts
//
// Pusher private-channel authorization.
//
// SECURITY: this endpoint must never authorize a subscription based on the
// request body alone. The client sends `channel_name`, and resource identifiers
// are embedded in that string, so trusting it would let any authenticated user
// subscribe to any other tenant's streams by guessing an id.
//
// Authorizable private channel shapes:
//   1. `private-agent-${sessionId}`: Caller must be the owner of the AgentSession.
//   2. `private-org-${orgId}`: Caller must have an active Membership in the Organization.
//   3. `private-workflow-${runId}`: Caller must have an active Membership in the
//      Organization that owns the Workflow of the WorkflowRun.
//
// Anything else is refused (403 Forbidden) rather than signed.

import { NextRequest, NextResponse } from "next/server";

import { pusherServer } from "@/lib/pusher/pusher-server";
import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import {
  extractAgentSessionId,
  parsePusherAuthBody,
} from "@/lib/pusher/agent-channel";
import { extractOrganizationId } from "@/lib/pusher/org-channel";
import { extractWorkflowRunId } from "@/lib/pusher/workflow-channel";

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

  // 1. Agent Session Channel: private-agent-<sessionId>
  const sessionId = extractAgentSessionId(channelName);
  if (sessionId) {
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

  // 2. Organization Event Channel: private-org-<orgId>
  const orgId = extractOrganizationId(channelName);
  if (orgId) {
    const membership = await db.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      select: { id: true },
    });

    if (!membership) {
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

  // 3. Workflow Run Live Stream Channel: private-workflow-<runId>
  const runId = extractWorkflowRunId(channelName);
  if (runId) {
    const run = await db.workflowRun.findFirst({
      where: {
        id: runId,
        workflow: {
          organization: {
            memberships: {
              some: { userId },
            },
          },
        },
      },
      select: { id: true },
    });

    if (!run) {
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

  // Refuse any non-authorizable channel shape
  return NextResponse.json(
    { error: "Channel is not authorizable" },
    { status: 403 },
  );
}
