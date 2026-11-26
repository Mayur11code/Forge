"use client";

import { useState } from "react";
import { AlertCircle, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { createOrganizationAction } from "@/app/actions/settings/createOrg";

export function OnboardingFormComponent() {
  const [name, setName] = useState("");
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  );
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const slugPreview = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/(^-|-$)/g, "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim()) {
      setErrorMessage("Please enter an organization or workspace name.");
      return;
    }

    setIsLoading(true);

    try {
      const result = await createOrganizationAction({
        name: name.trim(),
        idempotencyKey,
      });
      if (!result.success) {
        setErrorMessage(result.error || "Failed to create organization.");
        setIsLoading(false);
        return;
      }

      window.location.href = result.redirectUrl || `/org/${result.orgSlug}/dashboard`;
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "An unexpected error occurred. Please try again."
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto p-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl text-zinc-100">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-400 mb-1">
            <Sparkles className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Name your organization
          </h1>
          <p className="text-sm text-zinc-400">
            Create a shared workspace for your projects, tasks, and automated workflows.
          </p>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-3 p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm animate-in fade-in"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 font-medium">{errorMessage}</div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="org-name"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2"
            >
              Organization Name
            </label>
            <input
              id="org-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
              maxLength={50}
              disabled={isLoading}
              className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50 text-base font-medium"
            />
          </div>

          {/* Slug URL Preview */}
          <div className="p-3.5 bg-zinc-950/60 border border-zinc-800/80 rounded-xl text-xs space-y-1">
            <span className="text-zinc-500 font-medium">Workspace URL:</span>
            <div className="font-mono text-zinc-300 truncate">
              https://forge.app/org/
              <span className="text-blue-400 font-semibold">
                {slugPreview || "your-workspace"}
              </span>
              /dashboard
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !name.trim()}
            className="w-full py-3.5 px-4 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white font-semibold rounded-xl shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Creating workspace...</span>
              </>
            ) : (
              <>
                <span>Create Workspace & Enter</span>
                <ArrowRight className="w-5 h-5" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
