"use client";

import { useState } from "react";

type CreateTaskFormProps = {
  onCreate: (title: string) => Promise<void> | void;
};

export default function CreateTaskForm({ onCreate }: CreateTaskFormProps) {
  const [title, setTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (title.trim().length < 3) return;

    setIsSubmitting(true);
   
    await onCreate(title.trim());
    setTitle("");
    setIsSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        placeholder="Add a new task…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring"
      />

      <button
        type="submit"
        disabled={isSubmitting || title.trim().length < 3}
        className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}
