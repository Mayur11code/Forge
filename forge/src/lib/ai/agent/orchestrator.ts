import "server-only";

import { AgentSessionStatus } from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { recordAgentEvent } from "./outbox";
import { AGENT_PROMPT_VERSION } from "./prompts/system-prompt";
import { sessionSelect } from "./session-service";
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

    // Session row, first user message, and the intent to run the loop are ONE
    // transaction.
    //
    // These were three separate steps with a crash window between them. The worst
    // case was a session committed at RUNNING with its opening message and no
    // event: it looked live to every read path, nothing would ever claim it
    // (step 0 was never requested), and no recovery sweep covers a session that
    // has never started, because staleness is judged from a heartbeat that this
    // row never produced. The user's first message would simply vanish.
    return db.$transaction(async (tx) => {
        const session = await tx.agentSession.create({
            data: {
                orgId,
                userId,
                status: AgentSessionStatus.RUNNING,
                currentStep: 0,
                // Stamped from the compiled-in constant, never from a request
                // field. A client cannot claim to be running a different prompt.
                promptVersion: AGENT_PROMPT_VERSION,
            },
            select: sessionSelect,
        });

        await createMessage({
            sessionId: session.id,
            step: 0,
            message: initialMessage,
            tx,
        });

        // Durable intent. The dispatcher delivers it, so a crash after this
        // commit still runs the turn. The idempotency key is the session id, so
        // a retried start cannot queue the same session twice.
        await recordAgentEvent({
            tx,
            eventType: "AGENT_LOOP_REQUESTED",
            sessionId: session.id,
            aggregateId: session.id,
            payload: { orgId, sessionId: session.id, expectedStep: 0 },
        });

        return session;
    });
}