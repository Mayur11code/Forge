// src/app/api/chat/route.ts
import {
    streamText,
    convertToModelMessages,
    type ModelMessage,
    type UIMessage,
} from "ai";
import { googleProvider } from "@/lib/ai/provider";
import { enforceTokenBudget } from "@/lib/ai/token-manager";
import { retrieveRelevantContext } from "@/lib/vector/retreiver";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";

export const maxDuration = 60;

const CHAT_HISTORY_BUDGET = 12_000;

type ChatRequestBody = {
    messages: UIMessage[];
    orgSlug: string;
};

function getLatestUserText(messages: ModelMessage[]): string {
    const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user");

    if (!lastUserMessage) return "";

    if (typeof lastUserMessage.content === "string") {
        return lastUserMessage.content.trim();
    }

    return lastUserMessage.content
        .filter(
            (part): part is Extract<(typeof lastUserMessage.content)[number], { type: "text" }> =>
                part.type === "text",
        )
        .map((part) => part.text)
        .join("")
        .trim();
}

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as Partial<ChatRequestBody>;
        const { messages, orgSlug } = body;

        if (!orgSlug || typeof orgSlug !== "string") {
            return new Response("Missing or invalid orgSlug", { status: 400 });
        }

        if (!Array.isArray(messages) || messages.length === 0) {
            return new Response("Missing or invalid messages", { status: 400 });
        }

        /*
          getOrgAccess must read the signed-in server session and verify the user
          belongs to orgSlug. orgSlug from the browser is only an identifier.
        */
        const orgAccess = await getOrgAccess(orgSlug);

        if (!orgAccess) {
            return new Response("Forbidden", { status: 403 });
        }

        const modelMessages = await convertToModelMessages(messages);

        const latestMessage = getLatestUserText(modelMessages);

        if (!latestMessage) {
            return new Response("Latest user message must contain text", {
                status: 400,
            });
        }

        const retrievedContext = await retrieveRelevantContext(
            latestMessage,
            orgAccess.organization.id,
        );



        const safeMessages = enforceTokenBudget(
            [...modelMessages],
            CHAT_HISTORY_BUDGET,
        );

        const result = streamText({
            model: googleProvider("gemini-2.5-flash"),
            system: `You are the Engineered Forge AI assistant.
You must answer the user's query strictly using the organizational context provided below.
If the answer is not contained in the context, politely say that you do not have that information. Do not hallucinate data.

--- RETRIEVED CONTEXT ---
${retrievedContext || "No relevant project context found in the database."}`,
            messages: safeMessages,
            maxOutputTokens: 1000,
            temperature: 0.2,
        });

        return result.toUIMessageStreamResponse();
    } catch (error) {
        console.error("❌ [CHAT API] Fatal Error:", error);
        return new Response("Internal Server Error", { status: 500 });
    }
}