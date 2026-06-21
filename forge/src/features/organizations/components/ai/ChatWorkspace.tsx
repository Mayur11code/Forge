"use client";

import React, { memo, useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";

const MarkdownBlock = memo(
  ({ content }: { content: string }) => (
    <div className="prose prose-invert prose-sm max-w-none prose-p:leading-7 prose-pre:border prose-pre:border-white/10 prose-pre:bg-black/30 prose-code:text-cyan-200 prose-strong:text-white">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  ),
  (prev, next) => prev.content === next.content,
);

MarkdownBlock.displayName = "MarkdownBlock";

const StreamingMarkdown = ({ content }: { content: string }) => {
  const blocks = useMemo(() => content.split("\n\n"), [content]);

  return (
    <div className="space-y-3">
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
        className={`group flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300 ${
          isUser ? "justify-end" : "justify-start"
        }`}
      >
        {!isUser && (
          <div className="mr-3 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-gradient-to-br from-cyan-300/25 to-blue-500/20 shadow-lg shadow-cyan-950/40">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-4 w-4 text-cyan-200"
              aria-hidden="true"
            >
              <path d="M12 3 4.5 7.25v9.5L12 21l7.5-4.25v-9.5L12 3Z" />
              <path d="m4.8 7.5 7.2 4.1 7.2-4.1M12 11.6V21" />
            </svg>
          </div>
        )}

        <article
          className={`relative max-w-[88%] overflow-hidden rounded-2xl border px-5 py-4 shadow-2xl backdrop-blur-xl sm:max-w-[78%] ${
            isUser
              ? "border-violet-300/20 bg-gradient-to-br from-violet-500 via-indigo-600 to-blue-700 text-white shadow-indigo-950/40"
              : "border-white/10 bg-slate-900/70 text-slate-100 shadow-black/30"
          }`}
        >
          {!isUser && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent" />
          )}

          <div className="mb-3 flex items-center gap-2">
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${
                isUser ? "text-violet-100/80" : "text-cyan-200/80"
              }`}
            >
              {isUser ? "You" : "Forge Intelligence"}
            </span>

            {!isUser && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/15 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.9)]" />
                Verified context
              </span>
            )}
          </div>

          <StreamingMarkdown content={text} />
        </article>

        {isUser && (
          <div className="ml-3 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-200/20 bg-violet-500/15 text-xs font-bold text-violet-100 shadow-lg shadow-violet-950/30">
            Y
          </div>
        )}
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
    <section className="relative isolate flex h-[700px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#07111f] shadow-[0_30px_100px_-30px_rgba(0,0,0,0.9)]">
      {/* Decorative background only */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-28 -top-28 h-80 w-80 rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="absolute -bottom-36 -right-24 h-96 w-96 rounded-full bg-violet-600/15 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:34px_34px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      </div>

      <header className="relative flex items-center justify-between border-b border-white/10 bg-slate-950/40 px-5 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-gradient-to-br from-cyan-300/25 to-blue-600/25 shadow-lg shadow-cyan-950/30">
            <div className="absolute h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,1)]" />
            <div className="h-5 w-5 rounded-md border border-cyan-200/40" />
          </div>

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-wide text-white">
              Engineered Forge
            </h2>
            <p className="mt-0.5 truncate text-[11px] font-medium tracking-wide text-slate-400">
              ORGANIZATIONAL INTELLIGENCE CONSOLE
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-400/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
            RAG online
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[10px] text-slate-400">
            GEMINI · FLASH
          </span>
        </div>
      </header>

      <main className="scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/15 bg-cyan-300/5 shadow-[0_0_60px_-15px_rgba(34,211,238,0.35)]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-7 w-7 text-cyan-200"
                aria-hidden="true"
              >
                <path d="M12 3 4.5 7.25v9.5L12 21l7.5-4.25v-9.5L12 3Z" />
                <path d="m4.8 7.5 7.2 4.1 7.2-4.1M12 11.6V21" />
              </svg>
            </div>

            <p className="text-base font-medium text-slate-100">
              Your workspace intelligence is ready.
            </p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">
              Ask about tasks, project activity, blockers, or information indexed
              from your organization.
            </p>

            <div className="mt-7 flex flex-wrap justify-center gap-2">
              {["Summarize active tasks", "What is blocked?", "Recent project updates"].map(
                (label) => (
                  <span
                    key={label}
                    className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs text-slate-400"
                  >
                    {label}
                  </span>
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-5">
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

      <footer className="border-t border-white/10 bg-slate-950/50 p-4 backdrop-blur-xl sm:p-5">
        <form onSubmit={onSubmit} className="mx-auto max-w-5xl">
          <div className="group relative flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.045] p-2 shadow-xl shadow-black/20 transition-all focus-within:border-cyan-300/35 focus-within:bg-white/[0.07] focus-within:ring-4 focus-within:ring-cyan-400/5">
            <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-slate-400 sm:flex">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
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
                  ? "Forge is analyzing organizational context..."
                  : "Ask your organization anything..."
              }
              className="min-w-0 flex-1 bg-transparent px-2 py-3 text-sm text-white outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
            />

            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              aria-label="Send message"
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-4 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition-all hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 sm:px-5"
            >
              {isLoading ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" />
                  <span className="hidden sm:inline">Analyzing</span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">Send</span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
                    <path d="M22 2 11 13" />
                  </svg>
                </>
              )}
            </button>
          </div>

          <p className="mt-3 text-center text-[10px] tracking-wide text-slate-500">
            RESPONSES ARE GROUNDED IN YOUR ORGANIZATION’S INDEXED CONTEXT
          </p>
        </form>
      </footer>
    </section>
  );
}