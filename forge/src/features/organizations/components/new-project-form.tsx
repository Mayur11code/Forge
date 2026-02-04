"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/app/org/[orgId]/projects/action";

export default function NewProjectForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setLoading(true);
    setError(null);

  
      await createProject(orgSlug, {
        name: formData.get("name") as string,
        description: formData.get("description") as string,
      });
      // redirect handled by server action
   
  }

  return (
    <form
      action={onSubmit}
      className="space-y-5 rounded-xl bg-black p-6 text-zinc-100"
    >
      <h2 className="text-lg font-semibold tracking-tight">
        Create new project
      </h2>

      <div className="space-y-1">
        <label className="text-sm text-zinc-400">Project name</label>
        <input
          name="name"
          required
          autoFocus
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm text-zinc-400">Description</label>
        <textarea
          name="description"
          rows={3}
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
        />
      </div>

      {error && (
        <p className="text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-3 pt-2">
        {/* Cancel = close modal */}
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create"}
        </button>
      </div>
    </form>
  );
}
