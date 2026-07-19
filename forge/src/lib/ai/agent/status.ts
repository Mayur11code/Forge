import { pusherServer } from "@/lib/pusher/pusher-server";
import type { AgentStatusEvent } from "./types";

/**
 * Pusher is live transport only.
 * AgentSession in Postgres remains the source of truth.
 */

export async function publishAgentStatus(
  sessionId: string,
  event: AgentStatusEvent,
) {
  await pusherServer.trigger(
    `private-agent-${sessionId}`,
    "AGENT_STATUS_CHANGE",
    event,
  );
}