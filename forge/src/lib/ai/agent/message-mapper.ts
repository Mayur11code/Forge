import type { Prisma } from "@prisma/client";
import type { ModelMessage } from "ai";

export function buildModelMessages(
    messages: {
        message: Prisma.JsonValue;
    }[],
): ModelMessage[] {
    return messages.map(
        ({ message }) => message as ModelMessage,
    );
}