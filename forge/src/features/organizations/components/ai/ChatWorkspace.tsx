"use client";

import React, { memo, useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";

const MarkdownBlock = memo(
  ({ content }: { content: string }) => (
    <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:border prose-pre:border-zinc-800 prose-pre:bg-zinc-950 prose-code:text-zinc-300 prose-strong:text-zinc-100 prose-a:text-zinc-400">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  ),
  (prev, next) => prev.content === next.content,
);

MarkdownBlock.displayName = "MarkdownBlock";

const StreamingMarkdown = ({ content }: { content: string }) => {
  const blocks = useMemo(() => content.split("\n\n"), [content]);

  return (
    <div className="space-y-4">
      {blocks.map((blockText, index) => {
        const isLast = index === blocks.length - 1;

        return (
          <MarkdownBlock
            key={index}
            content={isLast ? blockText : `${blockText}\n\n`}
          />
        );
      })}
    </div>
  );
};

const ChatBubble = memo(
  ({ message }: { message: UIMessage }) => {
    const isUser = message.role === "user";

    const text = message.parts
      .filter(
        (part): part is Extract<typeof part, { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");

    return (
      <div
        className={`group flex w-full animate-in fade-in slide-in-from-bottom-2 duration-500 ${
          isUser ? "justify-end" : "justify-start"
        }`}
      >
        {!isUser && (
          <div className="mr-3 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/50 shadow-sm">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-4 w-4 text-zinc-500"
              aria-hidden="true"
            >
              <path d="M12 3 4.5 7.25v9.5L12 21l7.5-4.25v-9.5L12 3Z" />
              <path d="m4.8 7.5 7.2 4.1 7.2-4.1M12 11.6V21" />
            </svg>
          </div>
        )}

        <article
          className={`relative max-w-[88%] overflow-hidden rounded-2xl border px-5 py-4 shadow-sm backdrop-blur-md sm:max-w-[78%] ${
            isUser
              ? "border-zinc-800 bg-[#141416] text-zinc-200"
              : "border-zinc-800/60 bg-transparent text-zinc-300"
          }`}
        >
          <div className="mb-3 flex items-center gap-2">
            <span
              className={`text-[10px] font-medium uppercase tracking-[0.2em] ${
                isUser ? "text-zinc-500" : "text-zinc-500"
              }`}
            >
              {isUser ? "You" : "Forge Intelligence"}
            </span>

            {!isUser && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-0.5 text-[9px] uppercase tracking-widest text-zinc-400">
                <span className="h-1 w-1 rounded-full bg-zinc-500" />
                Verified
              </span>
            )}
          </div>

          <StreamingMarkdown content={text} />
        </article>
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.role === next.message.role &&
    prev.message.parts === next.message.parts,
);

ChatBubble.displayName = "ChatBubble";

function AutoScroller({
  messageCount,
  streamingText,
}: {
  messageCount: number;
  streamingText: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: streamingText ? "auto" : "smooth",
      block: "end",
    });
  }, [messageCount, streamingText]);

  return <div ref={bottomRef} className="h-2" />;
}

export function ChatWorkspace({ orgSlug }: { orgSlug: string }) {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: {
        orgSlug,
      },
    }),
  });

  const [input, setInput] = React.useState("");
  const isLoading = status === "submitted" || status === "streaming";

  const lastMessage = messages.at(-1);
  const lastMessageText =
    lastMessage?.parts
      .filter(
        (part): part is Extract<typeof part, { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("") ?? "";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = input.trim();
    if (!text || isLoading) return;

    sendMessage({ text });
    setInput("");
  }

  return (
    <section className="relative isolate flex h-[700px] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#0a0a0a] shadow-2xl">
      {/* Decorative dark background - purely vignette and grain style */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900/20 via-[#0a0a0a] to-[#0a0a0a]">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay" />
      </div>

      <header className="relative flex items-center justify-between border-b border-zinc-800 bg-[#0a0a0a]/80 px-5 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="absolute h-1.5 w-1.5 rounded-full bg-zinc-400" />
            <div className="h-4 w-4 rounded-sm border border-zinc-600/50" />
          </div>

          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium tracking-wide text-zinc-200">
              Engineered Forge
            </h2>
            <p className="mt-0.5 truncate text-[10px] uppercase tracking-widest text-zinc-500">
              Intelligence Console
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-3 sm:flex">
          <span className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1 text-[9px] uppercase tracking-widest text-zinc-400">
            <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400" />
            RAG Active
          </span>
          <span className="rounded-md border border-zinc-800 bg-zinc-900/30 px-2.5 py-1 font-mono text-[9px] tracking-widest text-zinc-500">
            GEMINI · FLASH
          </span>
        </div>
      </header>

      <main className="scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-800 flex-1 overflow-y-auto px-4 py-8 sm:px-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/50">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                className="h-6 w-6 text-zinc-500"
                aria-hidden="true"
              >
                <path d="M12 3 4.5 7.25v9.5L12 21l7.5-4.25v-9.5L12 3Z" />
                <path d="m4.8 7.5 7.2 4.1 7.2-4.1M12 11.6V21" />
              </svg>
            </div>

            <p className="text-sm font-medium text-zinc-300 tracking-wide">
              System initialized.
            </p>
            <p className="mt-2 max-w-xs text-xs leading-relaxed text-zinc-500">
              The organizational index is ready. Query your workspace logs, tasks, and history.
            </p>

            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {["Summarize active tasks", "Identify blockers", "Recent updates"].map(
                (label) => (
                  <span
                    key={label}
                    className="rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-1.5 text-[11px] tracking-wide text-zinc-500 transition-colors hover:text-zinc-300 cursor-default"
                  >
                    {label}
                  </span>
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-6">
            {messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
          </div>
        )}

        <AutoScroller
          messageCount={messages.length}
          streamingText={lastMessageText}
        />
      </main>

      <footer className="border-t border-zinc-800 bg-[#0a0a0a]/90 p-4 backdrop-blur-xl sm:p-5">
        <form onSubmit={onSubmit} className="mx-auto max-w-4xl">
          <div className="group relative flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1.5 transition-all focus-within:border-zinc-700 focus-within:bg-zinc-900">
            <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-600 sm:flex">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </div>

            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={isLoading}
              placeholder={
                isLoading
                  ? "Analyzing context..."
                  : "Ask your organization..."
              }
              className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
            />

            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              aria-label="Send message"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-zinc-200 px-4 text-xs font-semibold tracking-wide text-zinc-900 transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 sm:px-5"
            >
              {isLoading ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-900/30 border-t-zinc-900" />
              ) : (
                "Send"
              )}
            </button>
          </div>

          <p className="mt-3 text-center text-[9px] uppercase tracking-[0.2em] text-zinc-600">
            Contextually Grounded
          </p>
        </form>
      </footer>
    </section>
  );
}