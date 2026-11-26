"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home, Terminal, Compass } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log unexpected client or SSR failure to monitoring
    console.error("[FORGE_RUNTIME_INTERCEPT]:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col justify-between selection:bg-zinc-800 selection:text-zinc-100 font-sans relative overflow-hidden">
      {/* Background Architectural Mesh */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-amber-950/20 via-black to-black pointer-events-none" />
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Top Header Bar */}
      <header className="relative z-10 border-b border-white/[0.08] px-6 py-4 flex items-center justify-between text-xs font-mono text-zinc-500">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-amber-500/80 animate-ping" />
          <span className="text-zinc-300 font-semibold tracking-wider">FORGE SUPERVISOR</span>
          <span className="text-zinc-600">/</span>
          <span>FAULT_ISOLATION</span>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-zinc-500">
          <span>CODE:</span>
          <span className="font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            ERR_SUB_FAULT
          </span>
        </div>
      </header>

      {/* Center Error Section */}
      <main className="relative z-10 max-w-2xl mx-auto px-6 py-16 flex flex-col items-center text-center">
        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs font-mono tracking-wide mb-6">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          <span>[ 500 ] // RUNTIME_INTERCEPT_CONTAINED</span>
        </div>

        {/* Primary Glitch Typography */}
        <h1 className="text-4xl sm:text-6xl font-extralight tracking-tight text-white mb-4">
          Subsystem execution <span className="font-medium text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-zinc-200 to-zinc-500">interrupted.</span>
        </h1>

        <p className="text-sm sm:text-base text-zinc-400 max-w-lg mb-8 leading-relaxed font-light">
          An unhandled domain event or rendering boundary exception was contained by the runtime supervisor. Underlying state records remain immutable under PostgreSQL row mutexes.
        </p>

        {/* Diagnostic Terminal Box */}
        <div className="w-full bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-4 text-left font-mono text-xs text-zinc-400 mb-8 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2 mb-3 text-zinc-500">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-amber-400" />
              <span>ISOLATION_DIAGNOSTICS</span>
            </div>
            {error.digest && (
              <span className="text-[10px] text-zinc-500 font-mono">
                DIGEST: {error.digest}
              </span>
            )}
          </div>
          <div className="space-y-1 text-zinc-400 font-mono text-[11px] break-all">
            <p>
              <span className="text-zinc-600">&gt;</span> FAULT:{" "}
              <span className="text-amber-400">
                {error.message || "An unexpected error interrupted processing."}
              </span>
            </p>
            <p>
              <span className="text-zinc-600">&gt;</span> RECOVERY_STRATEGY:{" "}
              <span className="text-zinc-300">Transient rollback / retry viable</span>
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-3 w-full sm:w-auto">
          <button
            onClick={() => reset()}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs font-mono transition-all duration-200 shadow-lg shadow-amber-500/5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry Execution
          </button>

          <Link
            href="/select-org"
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-mono transition-all duration-200"
          >
            <Compass className="w-3.5 h-3.5" />
            Workspace Hub
          </Link>

          <Link
            href="/"
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-mono transition-all duration-200"
          >
            <Home className="w-3.5 h-3.5" />
            Landing Page
          </Link>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="relative z-10 border-t border-white/[0.08] px-6 py-4 flex flex-col sm:flex-row items-center justify-between text-[11px] font-mono text-zinc-600 gap-2">
        <div>FORGE ERROR RECOVERY BOUNDARY · TRANSACTION SAFE</div>
        <div>FAULT_DOMAIN: CLIENT_ROUTER</div>
      </footer>
    </div>
  );
}
