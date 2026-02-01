"use client";

import { signIn } from "next-auth/react"; // Client-side sign in
import { useState } from "react";

export function LoginFormComponent() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleCredentialsLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    // This triggers the 'authorize' function in your auth.ts
    await signIn("credentials", {
      email,
      password,
      callbackUrl: "/org/default/dashboard", // Where to go after success
    });
  };

  return (
    <div className="space-y-4">
      {/* 1. Google Provider - Fast and Pretty */}
      <button
        onClick={() => signIn("google", { callbackUrl: "/org/default/dashboard" })}
        className="w-full flex items-center justify-center gap-3 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <img src="/google-icon.svg" alt="Google" className="w-5 h-5" />
        <span className="text-gray-700 font-medium">Continue with Google</span>
      </button>

      <div className="relative flex items-center py-4">
        <div className="flex-grow border-t border-gray-200"></div>
        <span className="flex-shrink mx-4 text-gray-400 text-xs uppercase">Or email</span>
        <div className="flex-grow border-t border-gray-200"></div>
      </div>

      {/* 2. Credentials Provider - Traditional */}
      <form onSubmit={handleCredentialsLogin} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Email Address</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="name@company.com"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="••••••••"
            required
          />
        </div>
        <button
          type="submit"
          className="w-full py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors shadow-md"
        >
          Sign In
        </button>
      </form>
    </div>
  );
}