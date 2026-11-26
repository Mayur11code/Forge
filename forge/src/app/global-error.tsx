"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[FORGE_ROOT_CATASTROPHIC_ERROR]:", error);
  }, [error]);

  return (
    <html lang="en" className="dark bg-black text-white">
      <body className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 font-mono">
        <div className="max-w-md w-full border border-rose-500/40 bg-zinc-950 p-6 rounded-2xl shadow-2xl text-center space-y-4">
          <div className="inline-flex p-3 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            Root Boundary Intercept
          </h2>
          <p className="text-xs text-zinc-400 leading-relaxed font-sans">
            A fatal root layout exception occurred. The process was suspended to protect system invariants.
          </p>
          <div className="p-3 bg-black/60 border border-zinc-800 rounded-lg text-left text-[11px] text-zinc-400 break-all font-mono">
            {error.message || "Root rendering fault"}
          </div>
          <div className="flex gap-2 justify-center pt-2">
            <button
              onClick={() => reset()}
              className="px-4 py-2 bg-white text-black text-xs font-semibold rounded-lg hover:bg-zinc-200 transition-colors flex items-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reboot App
            </button>
            <button
              onClick={() => (window.location.href = "/")}
              className="px-4 py-2 border border-zinc-800 bg-zinc-900 text-zinc-300 text-xs rounded-lg hover:text-white transition-colors"
            >
              Emergency Exit
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
