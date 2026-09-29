import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import type { AgentOutboxTx } from "../outbox";

import type { ModelMessage } from "ai";

type CreateMessageInput = {
    sessionId: string;
    step: number;
    toolCallId?: string;
    message: ModelMessage;
    /**
     * Optional transaction client.
     *
     * Present for the tool-result + outbox path, where the message and the
     * intent to continue the conversation must commit together. Omitted for
     * standalone writes that have nothing to be atomic with, which is the
     * behaviour every existing caller relies on.
     */
    tx?: AgentOutboxTx;
};

export async function createMessage({
    sessionId,
    step,
    toolCallId,
    message,
    tx,
}: CreateMessageInput
) {
    // The `message` cast is required and pre-existing: `ModelMessage` is a
    // union containing array-typed content, which Prisma's recursive
    // `InputJsonValue` cannot express even though the value is plain JSON on
    // the wire. Unchanged behaviour, only relocated so both branches share one
    // object.
    const data = {
        sessionId,
        step,
        toolCallId,
        message: message as unknown as Prisma.InputJsonValue,
    };

    if (tx) {
        return tx.agentMessage.create({ data });
    }

    return prisma.agentMessage.create({ data });
}

export async function getMessages(
    sessionId: string,
) {
    return prisma.agentMessage.findMany({
        where: {
            sessionId,
        },
        orderBy: {
            createdAt: "asc",
        },
    });
}