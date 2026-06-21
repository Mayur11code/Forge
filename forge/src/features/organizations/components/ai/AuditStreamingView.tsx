"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { architectureReportSchema } from "@/lib/ai/schemas";

type AuditStreamingViewProps = {
  rawCodePayload: string;
};

export function AuditStreamingView({
  rawCodePayload,
}: AuditStreamingViewProps) {
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/stream-audit",
    schema: architectureReportSchema,
  });

  function startAudit() {
    const payload = rawCodePayload.trim();

    if (!payload || isLoading) return;

    submit({
      rawCodePayload: payload,
    });
  }

  return (
    <section className="space-y-6 rounded-xl border border-zinc-800 bg-[#0a0a0a] p-6 text-zinc-200">
      <header className="flex flex-col gap-4 border-b border-zinc-800 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Engineered Forge
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            Live Architecture Audit
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Structured findings appear as the analysis streams.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isLoading && (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Stop audit
            </button>
          )}

          <button
            type="button"
            onClick={startAudit}
            disabled={!rawCodePayload.trim() || isLoading}
            className="rounded-lg bg-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? "Analyzing..." : "Run audit"}
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-300"
        >
          <p className="font-semibold">Audit failed</p>
          <p className="mt-1 text-red-300/80">{error.message}</p>
        </div>
      )}

      {!object && !isLoading && !error && (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Select code or technical context, then run the audit.
        </div>
      )}

      {(object?.summary || isLoading) && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">
              Architecture summary
            </h3>
          </div>

          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-400">
            {object?.summary || "Generating summary..."}
          </p>
        </div>
      )}

      {(object?.vulnerabilities?.length || isLoading) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">
              Findings
            </h3>

            <span className="text-xs text-zinc-500">
              {object?.vulnerabilities?.length ?? 0} identified
            </span>
          </div>

          <div className="space-y-3">
            {object?.vulnerabilities?.map((vulnerability, index) => (
              <article
                key={`${vulnerability?.path ?? "finding"}-${index}`}
                className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-5"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                      File path
                    </p>
                    <p className="mt-1 break-all font-mono text-sm text-zinc-200">
                      {vulnerability?.path || "Locating affected file..."}
                    </p>
                  </div>

                  <span className="w-fit rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                    {vulnerability?.riskLevel || "Evaluating"}
                  </span>
                </div>

                <div className="mt-4 border-t border-zinc-800 pt-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                    Recommended remediation
                  </p>

                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-400">
                    {vulnerability?.fixAction ||
                      "Generating remediation guidance..."}
                  </p>
                </div>
              </article>
            ))}

            {isLoading && !object?.vulnerabilities?.length && (
              <div className="rounded-lg border border-dashed border-zinc-800 p-5 text-sm text-zinc-500">
                Inspecting architecture and identifying findings...
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}