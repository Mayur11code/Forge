// src/lib/ai/cache-stream.ts
import crypto from "crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';

export interface SimulateCachedStreamOptions {
  headers?: Record<string, string> | HeadersInit;
}

/**
 * Returns a simulated AI SDK UI-message stream response for a cached text answer.
 * Emits text-start, text-delta, and text-end events immediately without artificial delay
 * to avoid holding serverless compute connections open.
 */
export function simulateCachedStream(
  text: string,
  options?: SimulateCachedStreamOptions
): Response {
  const messageId = `cached-${crypto.randomUUID()}`;

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'text-start',
        id: messageId,
      });

      writer.write({
        type: 'text-delta',
        id: messageId,
        delta: text,
      });

      writer.write({
        type: 'text-end',
        id: messageId,
      });
    },
  });

  const mergedHeaders = new Headers(options?.headers);
  mergedHeaders.set('X-Cache-Hit', 'HIT');

  return createUIMessageStreamResponse({
    stream,
    headers: mergedHeaders,
  });
}
