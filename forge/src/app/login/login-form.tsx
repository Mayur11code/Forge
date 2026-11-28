"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, ArrowRight, Loader2, ShieldCheck, Database, GitBranch } from "lucide-react";

interface LoginFormProps {
  callbackUrl?: string;
  registered?: boolean;
  defaultEmail?: string;
}

export function LoginFormComponent({
  callbackUrl,
  registered,
  defaultEmail = "",
}: LoginFormProps) {
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCredentialsLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);

    const targetUrl = callbackUrl || "/router";

    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      callbackUrl: targetUrl,
      redirect: false,
    });

    if (result?.error) {
      setErrorMessage("Invalid credentials. Please verify your email and password.");
      setIsLoading(false);
    } else {
      window.location.href = targetUrl;
    }
  };

  const signupHref = callbackUrl
    ? `/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/signup";

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
            <span>SYS_VERIFY // GATEWAY</span>
          </div>

          <h2 className="text-xl font-light tracking-[-0.02em] text-zinc-100">
            Deterministic <br />
            <span className="font-serif italic text-zinc-400 font-normal text-lg">
              multi-tenant orchestration.
            </span>
          </h2>

          <p className="text-xs text-zinc-400 font-light leading-relaxed">
            Authentication boundaries in Forge are enforced at the database level with row-level mutex transactions, tenant-isolated vector namespaces, and transactional outbox persistence.
          </p>
        </div>

        <div className="space-y-3 pt-4 border-t border-white/[0.08]">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Row Lock Mutex
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                PostgreSQL SELECT FOR UPDATE serialization
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Database className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Transactional Outbox
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Atomic domain CDC persistence & 0 event loss
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <GitBranch className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Reverse Saga Engine
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Deterministic DAG rollback & step recovery
              </div>
            </div>
          </div>
        </div>

        <div className="pt-2 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
          STATUS: PRODUCTION READY · LATENCY: &lt; 20MS
        </div>
      </div>

      {/* Right/Primary Auth Console (Form) */}
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
                IDENTITY // CONSOLE
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
              Welcome back{" "}
              <span className="font-serif italic text-zinc-400 font-normal text-xl sm:text-2xl">
                to Forge.
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 font-light leading-relaxed">
              Authenticate credentials to open your workspace console and automated runs.
            </p>
          </div>

          {/* Success Notification */}
          {registered && (
            <div
              role="status"
              className="flex items-start gap-3 p-3.5 bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 font-mono text-xs animate-in fade-in"
            >
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
              <div className="flex-1 leading-relaxed">
                <span className="font-bold text-emerald-400">[VERIFIED]</span> Account created successfully. Enter your password to initiate your session.
              </div>
            </div>
          )}

          {/* Error Notification */}
          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-3 p-3.5 bg-red-950/30 border border-red-500/30 text-red-300 font-mono text-xs animate-in fade-in"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              <div className="flex-1 leading-relaxed">
                <span className="font-bold text-red-400">[AUTH_REJECTED]</span> {errorMessage}
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleCredentialsLogin} className="space-y-4">
            <div>
              <label
                htmlFor="login-email"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Email Address
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
                placeholder="developer@company.com"
                required
                disabled={isLoading}
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label
                  htmlFor="login-password"
                  className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em]"
                >
                  Password
                </label>
              </div>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
                placeholder="••••••••••••"
                required
                disabled={isLoading}
              />
            </div>

            <button
              disabled={isLoading}
              type="submit"
              className="w-full py-3 px-4 mt-3 bg-zinc-100 hover:bg-white active:bg-zinc-200 text-zinc-950 font-mono text-xs font-semibold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_4px_25px_rgba(255,255,255,0.18)] active:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center gap-2 group cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-zinc-950" />
                  <span>Verifying credentials...</span>
                </>
              ) : (
                <>
                  <span>Sign in to console</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                </>
              )}
            </button>
          </form>

          {/* Footer Navigation */}
          <div className="pt-5 border-t border-white/[0.08] text-center text-xs font-mono text-zinc-400">
            <span>Do not have an account?</span>{" "}
            <Link
              href={signupHref}
              className="text-zinc-200 hover:text-white underline underline-offset-4 decoration-white/20 hover:decoration-white font-medium transition-colors"
            >
              Create account
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
