// src/lib/ai/token-manager.ts
import { getEncoding } from "js-tiktoken";
import type { ModelMessage, TextPart } from "ai";

const encoder = getEncoding("cl100k_base");

/**
 * Flattens a ModelMessage's content to the text that will actually be sent.
 *
 * ModelMessage.content is `string | Array<TextPart | ImagePart | FilePart>` -
 * there is no `parts` property. The previous version read `msg.parts`, which is
 * undefined on every ModelMessage, so any message carrying array content fell
 * through to the `return ""` arm and was counted as zero tokens. The budget
 * check then passed on prompts that were far over it, which is the one job this
 * file exists to prevent.
 *
 * Only text parts are counted. An image part is a URL or a data URL, and
 * measuring those as characters overstates the cost while truncating them is
 * meaningless, so they are skipped rather than guessed at.
 */
const extractText = (msg: ModelMessage): string => {
  const { content } = msg;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return "";
};

/**
 * Tokens reserved for the reply, the role markers, and the per-message overhead
 * the OpenAI wire format adds. Subtracted from the caller's budget so the
 * enforced limit is on the history rather than on history plus response.
 */
const RESERVED_TOKENS = 500;

export function countArrayTokens(messages: ModelMessage[]): number {
  // 3 is the fixed priming cost of every request envelope.
  let totalTokens = 3;

  for (const msg of messages) {
    totalTokens += 3;

    totalTokens += encoder.encode(msg.role).length;
    totalTokens += encoder.encode(extractText(msg)).length;
  }

  return totalTokens;
}

export function enforceTokenBudget(
  messages: ModelMessage[],
  maxAllowedTokens: number,
): ModelMessage[] {
  let currentTokens = countArrayTokens(messages);
  let prunedMessages = [...messages];

  while (currentTokens > maxAllowedTokens && prunedMessages.length >= 4) {
    // Index 0 is the system prompt and index 3+ is the conversation; the two
    // oldest turns between them are dropped first.
    const systemPrompt = prunedMessages[0];
    const preservedHistory = prunedMessages.slice(3);
    prunedMessages = [systemPrompt, ...preservedHistory];
    currentTokens = countArrayTokens(prunedMessages);
  }

  // The Guillotine Fallback: trimming turns cannot get under the budget, so the
  // last message is truncated instead.
  if (currentTokens > maxAllowedTokens) {
    const lastIndex = prunedMessages.length - 1;
    const lastMsg = prunedMessages[lastIndex];
    const rawContent = extractText(lastMsg);

    // Clamped at zero. The budget below 500 is what makes the original
    // `maxAllowedTokens - 500` negative, and a negative slice end drops from the
    // tail rather than truncating - so a small budget produced an arbitrarily
    // mangled remainder instead of an empty one.
    const allowedInLastMessage = Math.max(0, maxAllowedTokens - RESERVED_TOKENS);
    const safeText = encoder
      .decode(encoder.encode(rawContent).slice(0, allowedInLastMessage));

    // A tool message's content is `ToolResultPart[]` by contract. Rewriting it
    // as a string produces a message the provider rejects, so the guillotine only
    // applies to the roles that accept string content. This was previously
    // invisible because the return type was `any`.
    if (lastMsg.role === "tool") {
      return prunedMessages;
    }

    // Normalize the message to ensure Gemini gets a standard string content back
    prunedMessages[lastIndex] = {
      ...lastMsg,
      content: `${safeText}\n\n[SYSTEM: TRUNCATED FOR LENGTH]`,
    };
  }

  return prunedMessages;
}