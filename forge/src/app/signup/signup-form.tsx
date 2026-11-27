"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Eye, EyeOff, AlertCircle, ArrowRight, Loader2, Sparkles, KeyRound, Building2 } from "lucide-react";
import { registerUser } from "@/app/actions/user/registerUser";

interface SignupFormProps {
  inviteToken?: string;
  callbackUrl?: string;
}

export function SignupFormComponent({ inviteToken, callbackUrl }: SignupFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // Client-side validation checks
    if (!name.trim()) {
      setErrorMessage("Please enter your full name.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErrorMessage("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setIsLoading(true);

    try {
      // 1. Authoritative server action execution
      const result = await registerUser({
        name,
        email,
        password,
        confirmPassword,
        inviteToken: inviteToken || undefined,
        callbackUrl: callbackUrl || undefined,
      });

      if (!result.success) {
        setErrorMessage(result.error || "Registration failed. Please check your details.");
        setIsLoading(false);
        return;
      }

      // 2. Immediately establish session via credentials provider
      const destination = result.nextUrl || "/router";
      const signInResult = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        callbackUrl: destination,
        redirect: false,
      });

      if (signInResult?.error) {
        // Fallback: redirect to login if auto-signin encounters an issue
        window.location.href = `/login?registered=true&email=${encodeURIComponent(email)}`;
      } else {
        window.location.href = destination;
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "An unexpected error occurred. Please try again."
      );
      setIsLoading(false);
    }
  };

  const loginHref = callbackUrl
    ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : inviteToken
    ? `/login?callbackUrl=${encodeURIComponent(`/invite/${inviteToken}`)}`
    : "/login";

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
            <span>SYS_REGISTER // ONBOARD</span>
          </div>

          <h2 className="text-xl font-light tracking-[-0.02em] text-zinc-100">
            Initialize your <br />
            <span className="font-serif italic text-zinc-400 font-normal text-lg">
              team workspace.
            </span>
          </h2>

          <p className="text-xs text-zinc-400 font-light leading-relaxed">
            {inviteToken
              ? "You are joining an existing organization via a single-tenant cryptographic invitation token."
              : "Every new account receives an isolated multi-tenant organization sanctuary with strict RBAC boundaries and dedicated workflow execution state."}
          </p>
        </div>

        <div className="space-y-3 pt-4 border-t border-white/[0.08]">
          <div className="flex items-start gap-3">
            <Building2 className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Isolated Tenant
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Guaranteed zero cross-tenant leakage
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <KeyRound className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Bcrypt Salted Ciphers
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                12-round salted cryptographic hashing
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-mono font-semibold text-zinc-200 uppercase tracking-wider">
                Autonomous AI & Triggers
              </div>
              <div className="text-[10px] font-mono text-zinc-500">
                Real-time CDC triggers & dual-key proposals
              </div>
            </div>
          </div>
        </div>

        <div className="pt-2 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
          STANDALONE ENROLLMENT · ZERO COOKIE LEAKAGE
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
                REGISTRATION // CONSOLE
              </span>
            </div>

            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{inviteToken ? "INVITE DETECTED" : "NEW ACCOUNT"}</span>
            </div>
          </div>

          {/* Heading */}
          <div className="space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-light tracking-[-0.03em] text-zinc-100">
              Create account{" "}
              <span className="font-serif italic text-zinc-400 font-normal text-xl sm:text-2xl">
                on Forge.
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 font-light leading-relaxed">
              {inviteToken
                ? "Complete your profile to accept your organization invitation."
                : "Register credentials to author DAG workflows and orchestrate events."}
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
                <span className="font-bold text-red-400">[VALIDATION_FAILED]</span> {errorMessage}
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Full Name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Smith"
                required
                disabled={isLoading}
                className="w-full px-3.5 py-2.5 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Email Address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="developer@company.com"
                required
                disabled={isLoading}
                className="w-full px-3.5 py-2.5 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Password (min. 8 characters)
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  minLength={8}
                  disabled={isLoading}
                  className="w-full px-3.5 py-2.5 pr-10 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 focus:outline-none p-1 transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block font-mono text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.16em] mb-1.5"
              >
                Confirm Password
              </label>
              <div className="relative">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  minLength={8}
                  disabled={isLoading}
                  className="w-full px-3.5 py-2.5 pr-10 bg-black/60 border border-white/[0.12] hover:border-white/30 focus:border-white focus:ring-1 focus:ring-white/20 text-zinc-100 placeholder:text-zinc-600 font-mono text-xs sm:text-sm transition-all duration-200 outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 focus:outline-none p-1 transition-colors"
                  aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 mt-3 bg-zinc-100 hover:bg-white active:bg-zinc-200 text-zinc-950 font-mono text-xs font-semibold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_4px_25px_rgba(255,255,255,0.18)] active:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center gap-2 group cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-zinc-950" />
                  <span>Initializing workspace account...</span>
                </>
              ) : (
                <>
                  <span>Create account</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                </>
              )}
            </button>
          </form>

          {/* Footer Navigation */}
          <div className="pt-5 border-t border-white/[0.08] text-center text-xs font-mono text-zinc-400">
            <span>Already registered?</span>{" "}
            <Link
              href={loginHref}
              className="text-zinc-200 hover:text-white underline underline-offset-4 decoration-white/20 hover:decoration-white font-medium transition-colors"
            >
              Sign in to console
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
