"use client";

import { useState, useRef, useTransition, useOptimistic } from "react";
import { createComment } from "@/app/actions/comments/createComments";
import { formatRelativeTime } from "@/lib/time/formatRelativeTime";
import { useRouter } from "next/navigation";



interface Comment {
    id: string;
    content: string;
    createdAt: Date;
    user: {
        id: string;
        name: string | null;

    };
}

export default function CommentSection({
    orgSlug,
    taskId,
    initialComments,
}: {
    orgSlug: string;
    taskId: string;
    initialComments: Comment[];
}) {
    const [content, setContent] = useState("");
    const [isPending, startTransition] = useTransition();
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const router = useRouter();

    // 🧠 Optimistic State
    const [optimisticComments, addOptimisticComment] =
        useOptimistic<Comment[], Comment>(
            initialComments,
            (state, newComment) => [...state, newComment]
        );

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!content.trim()) return;
        if (isPending) return;

        const optimisticComment: Comment = {
            id: "temp-" + Math.random(),
            content,
            createdAt: new Date(),
            user: {
                id: "current",
                name: "You",
            },
        };

        // ✅ Reset the input field immediately
        setContent("");

        // ✅ Wrap both the optimistic update AND the server call in startTransition
        startTransition(async () => {
            // 1️⃣ This now happens inside a transition context
            addOptimisticComment(optimisticComment);

            // 2️⃣ Server mutation
            try {
                await createComment({
                    orgSlug,
                    taskId,
                    content,
                });

                router.refresh();
            } catch (err) {
                alert("Failed to send comment.");
                router.refresh(); // reset optimistic state
            }
            // 3️⃣ Scroll to bottom after the state has updated
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        });
    };

    return (
        <div className="space-y-6">

            {/* Comments List */}
            <div className="space-y-6 max-h-[400px] overflow-y-auto pr-2">
                {optimisticComments.length === 0 ? (
                    <p className="text-zinc-500">
                        Start the conversation.
                    </p>
                ) : (
                    optimisticComments.map((comment) => (
                        <div
                            key={comment.id}
                            className="flex gap-4 animate-in fade-in duration-300"
                        >

                            <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-semibold text-white">
                                {comment.user.name?.charAt(0) ?? "U"}
                            </div>

                            <div className="flex-1">
                                <div className="flex items-center gap-2 text-sm text-zinc-400">
                                    <span className="font-medium text-white">
                                        {comment.user.name}
                                    </span>
                                    <span>
                                        {formatRelativeTime(new Date(comment.createdAt))

                                        }
                                    </span>
                                </div>

                                <p className="text-zinc-300 mt-1 whitespace-pre-wrap">
                                    {comment.content}
                                </p>
                            </div>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {/* Comment Form */}
            <form onSubmit={handleSubmit} className="flex gap-3">
                <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Write a comment..."
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-sm text-white resize-none focus:outline-none focus:border-zinc-600"
                    rows={2}
                />

                <button
                    type="submit"
                    disabled={isPending || !content.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-500 transition disabled:opacity-50"
                >
                    Send
                </button>
            </form>
        </div>
    );
}
