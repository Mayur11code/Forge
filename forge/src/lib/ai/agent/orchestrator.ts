import "server-only";

import { publishEvent } from "@/lib/events/queue";
import {
    createAgentSession,
} from "./session-service";
import { ModelMessage } from "ai";
import { createMessage } from "./services/message-service";



type StartAgentSessionInput = {

    orgId: string;

    userId: string;

    initialMessage: ModelMessage;
};

export async function startAgentSession({
    orgId,
    userId,
    initialMessage,
}: StartAgentSessionInput) {

    const session = await createAgentSession({
        orgId,
        userId,
    });

    await createMessage({
    sessionId: session.id,
    step: 0,
    message: initialMessage,
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