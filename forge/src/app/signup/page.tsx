import { SignupFormComponent } from "./signup-form";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = {
  title: "Create an Account | Forge",
  description: "Register for Forge to build, automate, and monitor your team workflows.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<{ inviteToken?: string; callbackUrl?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};

  return (
    <div className="relative min-h-screen bg-[#060608] text-zinc-100 font-sans antialiased selection:bg-zinc-800 selection:text-white flex flex-col justify-between overflow-x-hidden">
      {/* Parallax Blueprint Grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.03] bg-[linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] bg-[size:48px_48px]"
      />

      {/* Subtle 35mm Analog Film Grain Texture */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 opacity-[0.035] mix-blend-screen bg-repeat"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Atmospheric Radial Spotlight */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_10%,rgba(255,255,255,0.06),transparent_70%)]"
      />

      {/* Museum-Grade Top Navigation Bar */}
      <header className="relative z-50 border-b border-white/[0.08] bg-[#060608]/85 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="group flex items-center gap-3 select-none">
              <span className="w-6 h-6 border border-zinc-700 bg-zinc-950 flex items-center justify-center font-mono text-xs font-bold text-zinc-300 group-hover:border-white group-hover:text-white transition-colors duration-300">
                F
              </span>
              <span className="font-mono text-xs tracking-[0.2em] uppercase text-zinc-100 font-semibold group-hover:text-white transition-colors duration-300">
                Forge
              </span>
            </Link>

            <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono text-zinc-500 border-l border-white/[0.08] pl-6">
              <span>Release 1.0</span>
              <span>·</span>
              <span className="text-zinc-400">Gateway // Sign up</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-1.5 px-3 py-1.5 border border-white/[0.1] hover:border-white/30 text-zinc-400 hover:text-zinc-200 text-xs font-mono tracking-wider transition-all duration-300"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>[ Home ]</span>
            </Link>

            <Link
              href={
                sp.callbackUrl
                  ? `/login?callbackUrl=${encodeURIComponent(sp.callbackUrl)}`
                  : "/login"
              }
              className="px-3.5 py-1.5 border border-white/[0.1] hover:border-white/30 text-zinc-300 hover:text-white text-xs font-mono tracking-wider transition-all duration-300"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Stage */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-12 sm:py-16">
        <SignupFormComponent
          inviteToken={sp.inviteToken}
          callbackUrl={sp.callbackUrl}
        />
      </main>

      {/* Engineering Footer */}
      <footer className="relative z-10 border-t border-white/[0.08] bg-[#060608]/85 backdrop-blur-xl py-4 px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
            <span className="text-zinc-400 font-medium">REGISTRATION_ACTIVE</span>
            <span>·</span>
            <span>MULTI_TENANT_ONBOARDING</span>
          </div>
          <div>
            <span>ROW_MUTEX // OUTBOX_PERSISTENCE // DETERMINISTIC_DAG</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
