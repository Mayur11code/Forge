"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Eye, EyeOff, AlertCircle, ArrowRight, Loader2 } from "lucide-react";
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
    <div className="w-full max-w-md mx-auto p-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl text-zinc-100">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400 mb-1">
            <span className="font-bold text-lg">F</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Create your account
          </h2>
          <p className="text-sm text-zinc-400">
            {inviteToken
              ? "Sign up to accept your organization invitation"
              : "Get started with Forge workflow orchestration"}
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
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="name"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
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
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
            >
              Email Address
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alex@company.com"
              required
              disabled={isLoading}
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
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
                placeholder="••••••••"
                required
                minLength={8}
                disabled={isLoading}
                className="w-full px-4 py-2.5 pr-11 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 focus:outline-none p-1"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5"
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
                placeholder="••••••••"
                required
                minLength={8}
                disabled={isLoading}
                className="w-full px-4 py-2.5 pr-11 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 focus:outline-none p-1"
                aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 px-4 mt-2 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white font-semibold rounded-xl shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Creating account...</span>
              </>
            ) : (
              <>
                <span>Create account</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer Navigation */}
        <p className="text-center text-sm text-zinc-400 pt-2 border-t border-zinc-800">
          Already have an account?{" "}
          <Link
            href={loginHref}
            className="font-semibold text-blue-400 hover:text-blue-300 transition-colors"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
