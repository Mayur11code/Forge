import "server-only";

import { publishEvent } from "@/lib/events/queue";
import {
    createAgentSession,
} from "./session-service";

import type {
    AgentSessionMessage,
} from "./types";

type StartAgentSessionInput = {

    orgId: string;

    userId: string;

    initialMessage: AgentSessionMessage;
};

export async function startAgentSession({
    orgId,
    userId,
    initialMessage,
}: StartAgentSessionInput) {

    const session = await createAgentSession({
        orgId,
        userId,
        initialMessage,
    });

    await publishEvent(
        "AGENT_LOOP_REQUESTED",
        {
            orgId,
            sessionId: session.id,
            expectedStep: 0,
        },
    );

    return session;
}