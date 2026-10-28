// src/app/api/chat/route.ts
import {
  streamText,
  convertToModelMessages,
  embed,
  type ModelMessage,
  type UIMessage,
} from 'ai';

import {
  resolveOrganizationLanguageModel,
  resolveOrganizationEmbeddingModel,
  AiResolverError,
} from '@/lib/ai/resolver';
import { enforceTokenBudget } from '@/lib/ai/token-manager';
import {
  retrieveRelevantContext,
  retrieveRelevantContextWithProvenance,
  type RetrievedContext,
} from '@/lib/vector/retreiver';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import {
  checkSemanticCache,
  setSemanticCache,
} from '@/lib/ai/semantic-cache';
import { simulateCachedStream } from '@/lib/ai/cache-stream';
import {
  checkRateLimit,
  createRateLimitResponse,
  RATE_LIMIT_POLICIES,
} from '@/lib/security/rate-limit';
import { getAiEnv } from '@/lib/env/server';
import { fingerprintPriorHistory } from '@/lib/ai/cache-identity';

export const maxDuration = 60;

const CHAT_HISTORY_BUDGET = 12_000;

/**
 * Version of the static system prompt template below. Part of cache identity,
 * because a different instruction produces a different answer for the same
 * sources.
 */
const CHAT_PROMPT_VERSION = 'v1';

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

/**
 * Reads the concrete model id off a resolved AI SDK model. If the id cannot be
 * determined, the model cannot be part of a verifiable cache identity and the
 * caller must skip caching rather than guess a default.
 */
function readResolvedModelId(model: unknown): string | null {
  if (typeof model === 'string') {
    return model.length > 0 ? model : null;
  }
  const modelId = (model as { modelId?: unknown } | null)?.modelId;
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : null;
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

    // AI Admission Control (Token Bucket)
    // Limits sustained interactive chat usage while permitting short conversational bursts.
    const rateLimitResult = await checkRateLimit({
      policy: RATE_LIMIT_POLICIES.AI_ADMISSION_CHAT,
      userId: orgAccess.userId,
      orgId: orgAccess.organization.id,
    });

    if (!rateLimitResult.allowed) {
      return createRateLimitResponse(rateLimitResult);
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
    const userId = orgAccess.userId;

    let cacheEnabled = false;
    try {
      const aiEnv = getAiEnv();
      cacheEnabled = aiEnv.ENABLE_SEMANTIC_CACHE === "true";
    } catch {
      cacheEnabled = false;
    }

    // The exact messages the model will see. Token budgeting can drop history,
    // so it must run before the cache identity is derived from that history.
    const safeMessages = enforceTokenBudget(
      [...modelMessages],
      CHAT_HISTORY_BUDGET,
    );
    // Prior history fingerprint excludes the current user turn so semantically
    // equivalent rephrasings can match while earlier context remains isolated.
    const historyFingerprint = fingerprintPriorHistory(safeMessages);

    let queryEmbedding: number[] | undefined = undefined;
    let embeddingModelId: string | null = null;
    let cacheModelId: string | null = null;
    let languageModel:
      | Awaited<ReturnType<typeof resolveOrganizationLanguageModel>>
      | undefined;
    let retrieval: RetrievedContext | undefined = undefined;

    if (cacheEnabled) {
      try {
        const embeddingModel = await resolveOrganizationEmbeddingModel({
          orgId,
        });
        embeddingModelId = readResolvedModelId(embeddingModel);

        if (embeddingModelId) {
          const { embedding } = await embed({
            model: embeddingModel,
            value: latestMessage,
            providerOptions: {
              google: {
                outputDimensionality: 768,
              },
            },
          });
          queryEmbedding = embedding;
        } else {
          // Without a concrete embedding model id the entry could not be
          // re-validated later; do not cache at all for this request.
          cacheEnabled = false;
          console.warn(
            "⚠️ [CHAT API] Embedding model id unavailable; semantic cache disabled for this request."
          );
        }
      } catch (err) {
        if (err instanceof AiResolverError) {
          throw err;
        }
        console.warn(
          "⚠️ [CHAT API] Cache embedding failed, failing open to uncached RAG:",
          err instanceof Error ? err.message : "Unknown error"
        );
      }

      if (queryEmbedding && queryEmbedding.length === 768) {
        // Step 4: Run current RAG retrieval using precomputed embedding to obtain structured provenance
        retrieval = await retrieveRelevantContextWithProvenance(
          latestMessage,
          orgId,
          queryEmbedding,
        );

        // Step 5: If retrieval provenance is complete and non-empty, evaluate semantic cache
        if (retrieval.provenanceComplete && retrieval.provenance.length > 0) {
          languageModel = await resolveOrganizationLanguageModel({ orgId });
          cacheModelId = readResolvedModelId(languageModel);

          if (cacheModelId && embeddingModelId) {
            const cachedAnswer = await checkSemanticCache(
              queryEmbedding,
              {
                orgId,
                userId,
                modelId: cacheModelId,
                embeddingModelId,
                promptVersion: CHAT_PROMPT_VERSION,
                historyFingerprint,
              },
              retrieval.provenance,
            );

            if (cachedAnswer) {
              return simulateCachedStream(cachedAnswer, {
                headers: rateLimitResult.headers,
              });
            }
          } else {
            cacheEnabled = false;
            console.warn(
              "⚠️ [CHAT API] Language model id unavailable; semantic cache disabled for this request."
            );
          }
        }
      }
    }

    // Normal RAG path on cache miss, rejected candidate, or cache disabled.
    // Reuses already-computed retrieval when available to avoid duplicate vector retrieval.
    if (!retrieval) {
      retrieval = cacheEnabled
        ? await retrieveRelevantContextWithProvenance(
            latestMessage,
            orgId,
            queryEmbedding,
          )
        : ({
            context: await retrieveRelevantContext(
              latestMessage,
              orgId,
              queryEmbedding,
            ),
            provenance: [],
            provenanceComplete: false,
          } satisfies RetrievedContext);
    }

    const retrievedContext = retrieval.context;

    if (!languageModel) {
      languageModel = await resolveOrganizationLanguageModel({ orgId });
    }
    const activeLanguageModel = languageModel;
    if (!cacheModelId && activeLanguageModel) {
      cacheModelId = readResolvedModelId(activeLanguageModel);
    }

    const result = streamText({
      model: activeLanguageModel,
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
        if (
          !text.trim() ||
          !cacheEnabled ||
          !queryEmbedding ||
          !cacheModelId ||
          !embeddingModelId
        ) {
          return;
        }

        // Never cache an answer whose sources cannot be re-validated: a
        // "nothing found" response is the most dangerous thing to reuse for a
        // different query later.
        if (
          !retrieval.provenanceComplete ||
          retrieval.provenance.length === 0
        ) {
          return;
        }

        await setSemanticCache(
          queryEmbedding,
          latestMessage,
          text,
          {
            orgId,
            userId,
            modelId: cacheModelId,
            embeddingModelId,
            promptVersion: CHAT_PROMPT_VERSION,
            historyFingerprint,
            provenanceComplete: retrieval.provenanceComplete,
            sources: retrieval.provenance,
          },
        );
      },
    });

    return result.toUIMessageStreamResponse({
      headers: rateLimitResult.headers,
    });
  } catch (error) {
    if (error instanceof AiResolverError) {
      return new Response(
        JSON.stringify({
          error: error.message,
          code: error.code,
        }),
        {
          status: error.code === "ORGANIZATION_KEY_REQUIRED" ? 402 : 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    console.error('❌ [CHAT API] Fatal Error:', error);

    return new Response('Internal Server Error', {
      status: 500,
    });
  }
}
