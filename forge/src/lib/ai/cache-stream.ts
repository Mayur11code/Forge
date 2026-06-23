// src/lib/ai/cache-stream.ts
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';

const CHUNK_SIZE = 20;
const CHUNK_DELAY_MS = 15;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function simulateCachedStream(text: string): Response {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const messageId = 'cached-answer';

      writer.write({
        type: 'text-start',
        id: messageId,
      });

      // Slice by characters so markdown, whitespace, and code blocks are preserved.
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        writer.write({
          type: 'text-delta',
          id: messageId,
          delta: text.slice(i, i + CHUNK_SIZE),
        });

        await sleep(CHUNK_DELAY_MS);
      }

      writer.write({
        type: 'text-end',
        id: messageId,
      });
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      'X-Cache-Hit': 'HIT',
    },
  });
}