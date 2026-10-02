// src/tests/vector/token-budget.test.ts
//
// The chat token budget, and why it was inert.
//
// /api/chat builds its history with convertToModelMessages and hands the result to
// enforceTokenBudget before every request. Two things in that path were broken in
// a way that made the budget decorative:
//
//   1. ModelMessage has no `parts` property. Its content is
//      `string | Array<TextPart | ImagePart | FilePart>`, and convertToModelMessages
//      produces the array form for ordinary text input - verified against the
//      installed SDK, not assumed. extractText read `msg.parts`, found undefined,
//      and returned "". Every message therefore counted as zero content tokens,
//      countArrayTokens returned roughly the per-message overhead, and the while
//      loop in enforceTokenBudget never pruned anything. The file's only job was
//      not being done.
//
//   2. The guillotine's `maxAllowedTokens - 500` is negative for any budget
//      below 500, and a negative slice end trims from the tail rather than
//      truncating, so a small budget produced an arbitrary remainder.
//
// The first is the reason this file exists: an undercount is not a visible
// failure, it is a budget that agrees with whatever you sent it.

import { convertToModelMessages } from "ai";
import type { ModelMessage } from "ai";
import { countArrayTokens, enforceTokenBudget } from "@/lib/ai/token-manager";

function uiMessage(text: string) {
  return {
    id: `m-${text.length}-${Math.floor(text.length / 7)}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

describe("token accounting", () => {
  it("counts content on messages in the shape the chat route actually sends", async () => {
    const long = "word ".repeat(400).trim();
    const messages: ModelMessage[] = await convertToModelMessages([
      uiMessage(long),
    ]);

    // Guards the assumption this whole file rests on: if the SDK ever hands back
    // string content for plain text, this fails loudly rather than the tests below
    // quietly testing a shape the route never produces.
    expect(Array.isArray(messages[0].content)).toBe(true);

    // A 2000-character message is well over 400 tokens. Counting it as ~0 is the
    // bug this test exists for.
    expect(countArrayTokens(messages)).toBeGreaterThan(400);
  });

  it("scales with content length", async () => {
    const short = await convertToModelMessages([uiMessage("hi")]);
    const long = await convertToModelMessages([uiMessage("word ".repeat(400))]);

    expect(countArrayTokens(long)).toBeGreaterThan(countArrayTokens(short) * 10);
  });

  it("counts string content and array content consistently", () => {
    const asString: ModelMessage[] = [{ role: "user", content: "hello world" }];
    const asArray: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ];

    expect(countArrayTokens(asArray)).toBe(countArrayTokens(asString));
  });

  it("ignores non-text parts rather than measuring them as characters", () => {
    const withImage: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            image: "https://example.invalid/a-very-long-image-url-string.png",
          },
        ],
      },
    ];

    const textOnly: ModelMessage[] = [{ role: "user", content: "look at this" }];

    expect(countArrayTokens(withImage)).toBe(countArrayTokens(textOnly));
  });
});

describe("enforceTokenBudget", () => {
  it("prunes history that exceeds the budget", async () => {
    const messages: ModelMessage[] = await convertToModelMessages([
      uiMessage("first question"),
      uiMessage("second question"),
      uiMessage("third question"),
      uiMessage("fourth question"),
      uiMessage("fifth question " + "detail ".repeat(200)),
    ]);

    expect(countArrayTokens(messages)).toBeGreaterThan(200);

    const pruned = enforceTokenBudget(messages, 120);
    expect(countArrayTokens(pruned)).toBeLessThan(countArrayTokens(messages));
  });

  it("leaves a message already inside the budget untouched", async () => {
    const messages: ModelMessage[] = await convertToModelMessages([
      uiMessage("short"),
      uiMessage("also short"),
    ]);

    expect(enforceTokenBudget(messages, 10_000)).toEqual(messages);
  });

  it("truncates to nothing rather than to garbage when the budget is under the reserve", () => {
    // Long enough that the old negative slice had tokens to keep: ~1000 tokens of
    // content against a budget of 100 made `slice(0, 100 - 500)` into
    // `slice(0, -400)`, which trims 400 from the tail and happily returns the
    // first 600 tokens of prose as though that were a valid truncation.
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(60);
    const messages: ModelMessage[] = [{ role: "user", content: prose }];

    expect(countArrayTokens(messages)).toBeGreaterThan(500);

    const result = enforceTokenBudget(messages, 100);
    const content = String(result[0].content);

    expect(content.trim()).toBe("[SYSTEM: TRUNCATED FOR LENGTH]");
  });

  it("keeps a leading prefix when the budget exceeds the reserve", () => {
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(60);
    const messages: ModelMessage[] = [{ role: "user", content: prose }];

    const result = enforceTokenBudget(messages, 520);
    const content = String(result[0].content);

    expect(content).toContain("the quick brown fox");
    expect(content).toContain("[SYSTEM: TRUNCATED FOR LENGTH]");
    // Truncated well short of the full text.
    expect(content.length).toBeLessThan(prose.length);
  });

  it("does not rewrite a tool message's structured content", () => {
    // ToolResultPart[] is the wire contract for tool output; a string here would
    // be rejected by the provider.
    const toolMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call-1",
          toolName: "search",
          output: { type: "json" as const, value: { hits: 3 } },
        },
      ],
    };

    const result = enforceTokenBudget([toolMessage], 10);

    expect(result[0].role).toBe("tool");
    expect(Array.isArray(result[0].content)).toBe(true);
  });
});