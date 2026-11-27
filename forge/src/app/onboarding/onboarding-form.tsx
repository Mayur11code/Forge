"use client";

import { useState } from "react";
import { AlertCircle, ArrowRight, Loader2, Sparkles, Building2, Shield, Hash } from "lucide-react";
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
    <div className="w-full max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
      {/* Left/Companion Architectural Column (Visible on Desktop) */}
      <div className="hidden lg:flex lg:col-span-5 flex-col justify-between space-y-6 p-8 border border-white/[0.08] bg-zinc-950/60 backdrop-blur-xl relative">
        {/* Subtle corner ticks */}
        <span className="absolute -top-1.5 -left-1.5 text-zinc-600 font-mono text-[10px] select-none">+</span>
        <span className="absolute -top-1.5 -right-1.5 text-zinc-600 font-mono text-[10px] select-none">+</span>
        <span className="absolute -bottom-1.5 -left-1.5 text-zinc-600 font-mono text-[10px] select-none">+</span>
        <span className="absolute -bottom-1.5 -right-1.5 text-zinc-600 font-mono text-[10px] select-none">+</span>

        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 border border-white/[0.1] bg-white/[0.03] text-[10px] font-mono tracking-widest uppercase text-zinc-400">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
            <span>SYS_PROVISION // TENANT</span>
          </div>

          <h2 className="text-xl font-light tracking-[-0.02em] text-zinc-100">
            Provisioning your <br />
            <span className="font-serif italic text-zinc-400 font-normal text-lg">
              organization anchor.
            </span>
          </h2>

          <p className="text-xs text-zinc-400 font-light leading-relaxed">
            Creating an organization establishes your multi-tenant boundary. You will become the primary administrator, protected by PostgreSQL row-level mutex invariants.
          </p>
        </div>

        <div className="space-y-3 pt-4 border-t border-white/[0.08]">
          <div className="flex items-start gap-3">
            <Building2 className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Isolated PostgreSQL Tenant
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                All projects, tasks, workflows scoped by organizationId
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Shield className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Sole Admin Invariant
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Row mutex ensures organization never orphaned
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Hash className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Idempotent Creation
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Deduplicated via UUID key: {idempotencyKey.slice(0, 14)}...
              </div>
            </div>
          </div>
        </div>

        <div className="pt-2 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
          STATUS: PROVISIONING READY · AUTO_SLUG_RESOLVER
        </div>
      </div>

      {/* Right/Primary Form Console */}
      <div className="w-full lg:col-span-7 relative p-8 sm:p-10 bg-zinc-950/85 border border-white/[0.1] backdrop-blur-2xl shadow-[0_20px_70px_rgba(0,0,0,0.85)]">
        {/* Subtle corner ticks */}
        <span className="absolute -top-1.5 -left-1.5 text-zinc-500 font-mono text-[10px] select-none">+</span>
        <span className="absolute -top-1.5 -right-1.5 text-zinc-500 font-mono text-[10px] select-none">+</span>
        <span className="absolute -bottom-1.5 -left-1.5 text-zinc-500 font-mono text-[10px] select-none">+</span>
        <span className="absolute -bottom-1.5 -right-1.5 text-zinc-500 font-mono text-[10px] select-none">+</span>

        <div className="space-y-6">
          {/* Header Strip */}
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 border border-zinc-700 bg-zinc-900 flex items-center justify-center font-mono text-[10px] font-bold text-zinc-200">
                F
              </span>
              <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-zinc-300 font-semibold">
                ORGANIZATION // INITIALIZE
              </span>
            </div>

            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>READY</span>
            </div>
          </div>

          {/* Heading */}
          <div className="space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-light tracking-[-0.03em] text-zinc-100">
              Name workspace{" "}
              <span className="font-serif italic text-zinc-400 font-normal text-xl sm:text-2xl">
                sanctuary.
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 font-light leading-relaxed">
              Create a shared organization workspace for your team projects, workflows, and automated runs.
            </p>
          </div>

          {/* Error Notification */}
          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-3 p-3.5 bg-red-950/30 border border-red-500/30 text-red-300 font-mono text-xs animate-in fade-in"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              <div className="flex-1 leading-relaxed">
                <span className="font-bold text-red-400">[PROVISIONING_FAILED]</span> {errorMessage}
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="org-name"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Organization Name
              </label>
              <input
                id="org-name"
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Aerospace"
                required
                maxLength={50}
                disabled={isLoading}
                className="w-full px-3.5 py-2.5 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
              />

              {/* Slug Preview */}
              <div className="mt-2.5 flex items-center gap-2 text-[11px] font-mono text-zinc-500">
                <span className="text-zinc-400">URL Identifier:</span>
                <span className="px-2 py-0.5 border border-white/[0.08] bg-white/[0.02] text-zinc-300">
                  /org/{slugPreview || "your-slug"}
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="w-full py-3 px-4 mt-3 bg-zinc-100 hover:bg-white active:bg-zinc-200 text-zinc-950 font-mono text-xs font-semibold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_4px_25px_rgba(255,255,255,0.18)] active:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center gap-2 group cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-zinc-950" />
                  <span>Provisioning workspace...</span>
                </>
              ) : (
                <>
                  <span>Create workspace & launch</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                </>
              )}
            </button>
          </form>

          <div className="pt-4 border-t border-white/[0.08] flex items-center justify-between text-[10px] font-mono text-zinc-500">
            <span>ROLE ASSIGNMENT: ADMIN</span>
            <span>AUDIT TRAIL: IMMUTABLE</span>
          </div>
        </div>
      </div>
    </div>
  );
}
