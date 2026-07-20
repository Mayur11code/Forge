import "server-only";

import { AgentMessageRole } from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import type { JsonValue } from "../types";

import type { ModelMessage } from "ai";

type CreateMessageInput = {
    sessionId: string;
    step: number;
    toolCallId?: string;
    message: ModelMessage;
};

export async function createMessage({
    sessionId,
    step,
    toolCallId,
    message
}: CreateMessageInput
) {
    return prisma.agentMessage.create({
        data: {
            sessionId,
            step,
            toolCallId,
            message,
        },
    });
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