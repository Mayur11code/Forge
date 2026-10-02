"use client";

import { Task } from "@prisma/client";
import { useState } from "react";
import { set } from "zod";

// Define the shape of your server action response
type CreateTaskResponse = {
  success: boolean;
  task?: Task;
  error?: string;
  remaining?: number;
  reset?: number;
};

type CreateTaskFormProps = {
  // Update: it now returns a Promise with the response object
  onCreate: (title: string) => Promise<CreateTaskResponse | undefined>;
};

export default function CreateTaskForm({ onCreate }: CreateTaskFormProps) {
  const [title, setTitle] = useState("");
  // const [isSubmitting, setIsSubmitting] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [localCount, setLocalCount] = useState(0);
// 0 means "no window started yet". Seeding this with Date.now() was an impure
  // render: the value is read while rendering, so a server render and a client
  // hydration each produce a different start time, which React reports as a
  // mismatch. The window opens on the first submit instead.
  const [windowStart, setWindowStart] = useState(0);

const LIMIT = 5;
const WINDOW = 10000; // 10 seconds

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const now = Date.now();

// A window that has expired contributes zero to the count. The original code
    // called setLocalCount(0) and then went on to test the `localCount` captured
    // in this closure, which still held the pre-reset value - so the first submit
    // after a window rolled over was still blocked by a count that no longer
    // existed.
    const windowExpired = windowStart === 0 || now - windowStart > WINDOW;
    const countInWindow = windowExpired ? 0 : localCount;

    if (windowExpired) {
      setWindowStart(now);
      setLocalCount(0);
    }

    // block if limit reached
    if (countInWindow >= LIMIT) {
      setRateLimited(true);
      const waitTime = WINDOW - (now - windowStart);

      setTimeout(() => {
        setRateLimited(false);
      }, waitTime);

      return;
    }

    setLocalCount(prev => prev + 1);
    if (title.trim().length < 3) return;

    // setIsSubmitting(true);

    try {
      setTitle("");
      const result = await onCreate(title.trim());
      if (result?.error === "RATE_LIMIT") {
        setRateLimited(true);
        // auto unlock after reset time
        const waitTime = result.reset? result.reset - Date.now() : 10000; // default to 10s if reset time is not provided
        console.warn("Fronend rate limit hit. Blocking for", waitTime, "ms");
        setTimeout(() => {
          setRateLimited(false);
        }, waitTime);
      }
    
    } catch (err: unknown) {
    // 🎯 Handle rate limit error
    const message = err instanceof Error ? err.message : "";

    if (message.includes("too fast")) {
      alert("⚠️ Slow down! Please wait a few seconds.");
    } else {
      alert("Something went wrong. Try again.");
    }
  } 
  }


return (
  <form onSubmit={handleSubmit} className="flex gap-2">
    <input
      type="text"
      placeholder="Add a new task…"
      value={title}
      onChange={(e) => setTitle(e.target.value)}

      className="
    w-full
    bg-zinc-950/80
    border border-zinc-800/60
    text-zinc-200
    shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]
    px-3 py-2
    rounded-lg
    text-sm
    outline-none
    focus:border-zinc-600
    focus:ring-0
    placeholder:text-zinc-600
    transition-all
    
  "
    />

    <button
      type="submit"
      disabled={title.trim().length < 3 || rateLimited}
      className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
    >
      {rateLimited ? "Wait..." : "Add"}
    </button>
  </form>
);
}
