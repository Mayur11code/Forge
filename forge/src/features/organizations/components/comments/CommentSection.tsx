"use client";

import React, { useState, useRef, useTransition, useOptimistic } from "react";
import { createComment } from "@/app/actions/comments/createComments";
import { deleteComment } from "@/app/actions/comments/deleteComment";
import { formatRelativeTime } from "@/lib/time/formatRelativeTime";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Trash2, Send, Loader2, MessageSquare } from "lucide-react";

export interface CommentUser {
  id: string;
  name: string | null;
  image?: string | null;
}

export interface CommentItem {
  id: string;
  content: string;
  createdAt: Date | string;
  user: CommentUser;
}

interface CommentSectionProps {
  orgSlug: string;
  taskId: string;
  initialComments: CommentItem[];
  currentUserId?: string;
  currentUserRole?: string;
}

type OptimisticAction =
  | { type: "ADD"; comment: CommentItem }
  | { type: "DELETE"; commentId: string };

export default function CommentSection({
  orgSlug,
  taskId,
  initialComments,
  currentUserId,
  currentUserRole,
}: CommentSectionProps) {
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  // Optimistic State Handling
  const [optimisticComments, updateOptimisticComments] = useOptimistic<
    CommentItem[],
    OptimisticAction
  >(initialComments, (state, action) => {
    switch (action.type) {
      case "ADD":
        return [...state, action.comment];
      case "DELETE":
        return state.filter((c) => c.id !== action.commentId);
      default:
        return state;
    }
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || isPending) return;

    const tempId = "temp-" + Date.now();
    const optimisticComment: CommentItem = {
      id: tempId,
      content: trimmed,
      createdAt: new Date(),
      user: {
        id: currentUserId || "current",
        name: "You",
      },
    };

    setContent("");

    startTransition(async () => {
      updateOptimisticComments({ type: "ADD", comment: optimisticComment });

      try {
        await createComment({
          orgSlug,
          taskId,
          content: trimmed,
        });
        router.refresh();
      } catch (err) {
        console.error("Failed to post comment:", err);
        router.refresh();
      }

      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const handleDelete = async (commentId: string) => {
    if (isPending || deletingCommentId) return;

    setDeletingCommentId(commentId);

    startTransition(async () => {
      updateOptimisticComments({ type: "DELETE", commentId });

      try {
        const res = await deleteComment({ orgSlug, commentId });
        if (!res.success) {
          alert(res.error || "Failed to delete comment");
          router.refresh();
        }
      } catch (err) {
        console.error("Error deleting comment:", err);
        router.refresh();
      } finally {
        setDeletingCommentId(null);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 pb-3">
        <MessageSquare className="w-4 h-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-200">
          Activity & Comments ({optimisticComments.length})
        </h3>
      </div>

      {/* Comments List */}
      <div className="space-y-4 max-h-[420px] overflow-y-auto pr-2 no-scrollbar">
        {optimisticComments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800/80 p-8 text-center">
            <p className="text-xs text-zinc-500">
              No comments yet. Start the conversation with your team.
            </p>
          </div>
        ) : (
          optimisticComments.map((comment) => {
            const isAuthor = currentUserId && comment.user.id === currentUserId;
            const isAdmin = currentUserRole === "ADMIN";
            const canDelete = isAuthor || isAdmin;
            const isDeleting = deletingCommentId === comment.id;

            return (
              <div
                key={comment.id}
                className="group relative flex gap-3 rounded-xl border border-zinc-850 bg-zinc-950/40 p-4 transition-all duration-200 hover:border-zinc-800 hover:bg-zinc-900/30"
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700/60 flex items-center justify-center text-xs font-semibold text-zinc-200 shrink-0">
                  {comment.user.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={comment.user.image}
                      alt={comment.user.name || "User"}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    comment.user.name?.charAt(0).toUpperCase() ?? "U"
                  )}
                </div>

                {/* Comment Body */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-zinc-200">
                        {comment.user.name || "Unknown Member"}
                      </span>
                      <span className="text-zinc-500 text-[11px]">
                        {formatRelativeTime(new Date(comment.createdAt))}
                      </span>
                    </div>

                    {/* Delete Action (Author or Admin Only) */}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => handleDelete(comment.id)}
                        disabled={isDeleting}
                        className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-red-400 rounded transition-all disabled:opacity-50"
                        title="Delete Comment"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Markdown Content */}
                  <div className="text-xs text-zinc-300 leading-relaxed prose prose-invert prose-xs max-w-none break-words">
                    <ReactMarkdown>{comment.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Comment Form */}
      <form onSubmit={handleSubmit} className="flex gap-2.5">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Add a comment with Markdown support (**bold**, `code`, - list)..."
          className="flex-1 bg-zinc-900/90 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-700 transition-colors"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />

        <button
          type="submit"
          disabled={isPending || !content.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-100 text-zinc-950 rounded-xl text-xs font-semibold hover:bg-white transition-colors disabled:opacity-40 self-end shadow-sm"
        >
          {isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}
