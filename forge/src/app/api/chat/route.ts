// src/app/api/chat/route.ts
import {
  streamText,
  convertToModelMessages,
  embed,
  type ModelMessage,
  type UIMessage,
} from 'ai';

import { googleProvider } from '@/lib/ai/provider';
import { enforceTokenBudget } from '@/lib/ai/token-manager';
import { retrieveRelevantContext } from '@/lib/vector/retreiver';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import {
  checkSemanticCache,
  setSemanticCache,
} from '@/lib/ai/semantic-cache';
import { simulateCachedStream } from '@/lib/ai/cache-stream';

export const maxDuration = 60;

const CHAT_HISTORY_BUDGET = 12_000;

type ChatRequestBody = {
  messages: UIMessage[];
  orgSlug: string;
};

/**
 * Extracts the latest textual user input from AI SDK ModelMessage objects.
 * UI messages can contain multiple parts, so `content` is not always a string.
 */
function getLatestUserText(messages: ModelMessage[]): string {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user');

  if (!lastUserMessage) {
    return '';
  }

  if (typeof lastUserMessage.content === 'string') {
    return lastUserMessage.content.trim();
  }

  return lastUserMessage.content
    .filter(
      (
        part,
      ): part is Extract<
        (typeof lastUserMessage.content)[number],
        { type: 'text' }
      > => part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<ChatRequestBody>;
    const { messages, orgSlug } = body;

    if (!orgSlug || typeof orgSlug !== 'string') {
      return new Response('Missing or invalid orgSlug', {
        status: 400,
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Missing or invalid messages', {
        status: 400,
      });
    }

    /*
     * getOrgAccess must validate the signed-in server session.
     * orgSlug supplied by the browser is not authorization by itself.
     */
    const orgAccess = await getOrgAccess(orgSlug);

    if (!orgAccess) {
      return new Response('Forbidden', {
        status: 403,
      });
    }

    const modelMessages = await convertToModelMessages(messages);

    const latestMessage = getLatestUserText(modelMessages);

    // Prevent Gemini's "EmbedContentRequest.content contains an empty Part" error.
    if (!latestMessage) {
      return new Response('Latest user message must contain text', {
        status: 400,
      });
    }

    const orgId = orgAccess.organization.id;

    // 1. Create the embedding once. Reuse it for cache lookup and cache write.
    const { embedding: queryEmbedding } = await embed({
      model: googleProvider.embeddingModel('gemini-embedding-001'),
      value: latestMessage,
      providerOptions: {
        google: {
          outputDimensionality: 768,
        },
      },
    });

    // 2. Semantic cache lookup: Pinecone finds a similar query; Redis holds its answer.
    const cachedAnswer = await checkSemanticCache(queryEmbedding, orgId);

    if (cachedAnswer) {
      /*
       * IMPORTANT:
       * simulateCachedStream must return an AI SDK UI-message stream response,
       * compatible with useChat / toUIMessageStreamResponse().
       */
      return simulateCachedStream(cachedAnswer);
    }

    // 3. Normal RAG path on cache miss.
    const retrievedContext = await retrieveRelevantContext(
      latestMessage,
      orgId,
    );

    const safeMessages = enforceTokenBudget(
      [...modelMessages],
      CHAT_HISTORY_BUDGET,
    );

    const result = streamText({
      model: googleProvider('gemini-2.5-flash'),
      system: `You are the Engineered Forge AI assistant.
You must answer the user's query strictly using the organizational context provided below.
If the answer is not contained in the context, politely say that you do not have that information. Do not hallucinate data.

--- RETRIEVED CONTEXT ---
${retrievedContext || 'No relevant project context found in the database.'}`,
      messages: safeMessages,
      maxOutputTokens: 1000,
      temperature: 0.2,

      // Runs after generation completes. Cache failure must not affect the response.
      onFinish: async ({ text }) => {
        if (!text.trim()) {
          return;
        }

        await setSemanticCache(
          queryEmbedding,
          latestMessage,
          text,
          orgId,
        );
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('❌ [CHAT API] Fatal Error:', error);

    return new Response('Internal Server Error', {
      status: 500,
    });
  }
}