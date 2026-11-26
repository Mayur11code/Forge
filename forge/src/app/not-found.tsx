"use client";

import Link from "next/link";
import { ArrowLeft, Compass, Home, ShieldAlert, Terminal } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col justify-between selection:bg-zinc-800 selection:text-zinc-100 font-sans relative overflow-hidden">
      {/* Background Architectural Mesh & Subtle Ambient Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900/40 via-black to-black pointer-events-none" />
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Top Header Bar */}
      <header className="relative z-10 border-b border-white/[0.08] px-6 py-4 flex items-center justify-between text-xs font-mono text-zinc-500">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-rose-500/80 animate-pulse" />
          <span className="text-zinc-300 font-semibold tracking-wider">FORGE DISPATCH</span>
          <span className="text-zinc-600">/</span>
          <span>ROUTER_GATEWAY</span>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-zinc-500">
          <span>CODE:</span>
          <span className="font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
            HTTP_404_DISCONNECTED
          </span>
        </div>
      </header>

      {/* Center Hero Card */}
      <main className="relative z-10 max-w-2xl mx-auto px-6 py-16 flex flex-col items-center text-center">
        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs font-mono tracking-wide mb-6">
          <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
          <span>[ 404 ] // TARGET_NODE_NOT_FOUND</span>
        </div>

        {/* Primary Glitch Typography */}
        <h1 className="text-4xl sm:text-6xl font-extralight tracking-tight text-white mb-4">
          Lost in the <span className="font-medium text-transparent bg-clip-text bg-gradient-to-r from-white via-zinc-200 to-zinc-500">compute graph.</span>
        </h1>

        <p className="text-sm sm:text-base text-zinc-400 max-w-lg mb-8 leading-relaxed font-light">
          The requested route, project partition, or task does not exist on this cluster, has been purged by tenant lifecycle policy, or is outside your current clearance.
        </p>

        {/* Telemetry Terminal Box */}
        <div className="w-full bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-4 text-left font-mono text-xs text-zinc-400 mb-8 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2 mb-3 text-zinc-500">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-zinc-400" />
              <span>ROUTER_DIAGNOSTICS</span>
            </div>
            <span className="text-[10px] uppercase text-zinc-600">Cluster: edge-primary-01</span>
          </div>
          <div className="space-y-1 text-zinc-400 font-mono text-[11px]">
            <p><span className="text-zinc-600">&gt;</span> <span className="text-rose-400">ERR_CANONICAL_LOOKUP_FAILED</span>: No route matched ingress rule.</p>
            <p><span className="text-zinc-600">&gt;</span> STATUS: <span className="text-zinc-300">404 NOT FOUND</span> · ZERO BYTES DISPATCHED</p>
            <p><span className="text-zinc-600">&gt;</span> SUGGESTION: Verify organization slug, project identifier, or task UUID.</p>
          </div>
        </div>

        {/* Navigation Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-3 w-full sm:w-auto">
          <button
            onClick={() => window.history.back()}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-mono transition-all duration-200"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Previous Route
          </button>

          <Link
            href="/select-org"
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-white/20 bg-white text-black hover:bg-zinc-200 text-xs font-medium transition-all duration-200 shadow-lg shadow-white/5"
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
        <div>FORGE DISTRIBUTED RUNTIME · TENANT ISOLATION HARDENED</div>
        <div>SHA: RUNTIME_REVI_41</div>
      </footer>
    </div>
  );
}
