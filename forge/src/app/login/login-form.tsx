"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, ArrowRight } from "lucide-react";

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
      setErrorMessage("Invalid email or password. Please try again.");
      setIsLoading(false);
    } else {
      window.location.href = targetUrl;
    }
  };

  const signupHref = callbackUrl
    ? `/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/signup";

  return (
    <div className="w-full max-w-md mx-auto p-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl text-zinc-100">
      <div className="space-y-6">
        {/* Header Section */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400 mb-1">
            <span className="font-bold text-lg">F</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Welcome back
          </h2>
          <p className="text-sm text-zinc-400">
            Sign in to your Forge workspace
          </p>
        </div>

        {/* Success Alert if just registered */}
        {registered && (
          <div
            role="status"
            className="flex items-start gap-3 p-3.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm animate-in fade-in"
          >
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 font-medium">
              Account created successfully! Please enter your password to sign in.
            </div>
          </div>
        )}

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

        {/* Credentials Provider Form */}
        <form onSubmit={handleCredentialsLogin} className="space-y-4">
          <div>
            <label
              htmlFor="login-email"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
            >
              Email Address
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
              placeholder="name@company.com"
              required
              disabled={isLoading}
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label
                htmlFor="login-password"
                className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider"
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
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
              placeholder="••••••••"
              required
              disabled={isLoading}
            />
          </div>

          <button
            disabled={isLoading}
            type="submit"
            className="w-full py-3 px-4 mt-2 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white font-semibold rounded-xl shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <span>Sign in</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-center text-sm text-zinc-400 pt-2 border-t border-zinc-800">
          Don&apos;t have an account?{" "}
          <Link
            href={signupHref}
            className="font-semibold text-blue-400 hover:text-blue-300 transition-colors"
          >
            Create account
          </Link>
        </p>
      </div>
    </div>
  );
}
