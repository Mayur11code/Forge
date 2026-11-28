import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma/db";
import Link from "next/link";
import {
  Building2,
  ArrowRight,
  Plus,
  Layers,
  Users,
  ArrowLeft,
} from "lucide-react";

export const metadata = {
  title: "Select Organization | Forge",
  description: "Select an organization to open your workspace dashboard.",
};

export default async function SelectOrgPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/select-org");
  }

  // Authoritative database membership query
  const memberships = await db.membership.findMany({
    where: {
      userId: session.user.id,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          _count: {
            select: {
              projects: true,
              memberships: true,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  // Zero memberships -> onboarding
  if (memberships.length === 0) {
    redirect("/onboarding");
  }

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
              <span className="text-zinc-400">Workspace // Select org</span>
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
              href="/onboarding"
              className="px-3.5 py-1.5 border border-white/[0.1] hover:border-white/30 text-zinc-300 hover:text-white text-xs font-mono tracking-wider transition-all duration-300 flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New org</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Stage */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-12 sm:py-16">
        <div className="max-w-2xl w-full mx-auto space-y-8">
          {/* Header */}
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 border border-white/[0.1] bg-white/[0.03] text-[10px] font-mono tracking-widest uppercase text-zinc-400">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              <span>AUTHENTICATED // {session.user.email}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-light tracking-[-0.03em] text-zinc-100">
              Select workspace{" "}
              <span className="font-serif italic text-zinc-400 font-normal text-xl sm:text-2xl">
                to launch.
              </span>
            </h1>

            <p className="text-xs sm:text-sm text-zinc-400 font-light leading-relaxed">
              Choose an active organization sanctuary to view team projects, DAG workflows, and telemetry.
            </p>
          </div>

          {/* Organizations Grid */}
          <div className="space-y-3">
            {memberships.map((m) => {
              const org = m.organization;
              const roleFormatted = m.role.toUpperCase();

              return (
                <div
                  key={m.id}
                  className="group relative p-6 bg-zinc-950/85 border border-white/[0.1] hover:border-white/30 transition-all duration-300 flex flex-col sm:flex-row sm:items-center justify-between gap-5 backdrop-blur-xl"
                >
                  {/* Subtle corner ticks */}
                  <span className="absolute -top-1 -left-1 text-zinc-600 font-mono text-[9px] select-none">+</span>
                  <span className="absolute -top-1 -right-1 text-zinc-600 font-mono text-[9px] select-none">+</span>
                  <span className="absolute -bottom-1 -left-1 text-zinc-600 font-mono text-[9px] select-none">+</span>
                  <span className="absolute -bottom-1 -right-1 text-zinc-600 font-mono text-[9px] select-none">+</span>

                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-11 h-11 border border-white/[0.15] bg-black/60 flex items-center justify-center text-sm font-mono font-bold text-zinc-200 uppercase shrink-0 group-hover:border-white/50 transition-colors">
                      {org.name.charAt(0) || "O"}
                    </div>

                    <div className="flex flex-col min-w-0 space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-medium text-white truncate text-base">
                          {org.name}
                        </span>
                        <span className="text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-0.5 border border-white/[0.1] bg-white/[0.04] text-zinc-300">
                          {roleFormatted}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-xs font-mono text-zinc-500">
                        <span className="text-zinc-400">/org/{org.slug}</span>
                        <span>·</span>
                        <span className="flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 text-zinc-500" />
                          {org._count.projects} projects
                        </span>
                        <span>·</span>
                        <span className="flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-zinc-500" />
                          {org._count.memberships} members
                        </span>
                      </div>
                    </div>
                  </div>

                  <Link
                    href={`/org/${org.slug}/dashboard`}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-100 hover:bg-white text-zinc-950 font-mono text-xs font-semibold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_4px_25px_rgba(255,255,255,0.18)] active:translate-y-0 shrink-0 cursor-pointer"
                  >
                    <span>Launch</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              );
            })}
          </div>

          {/* Action Bar */}
          <div className="pt-4 border-t border-white/[0.08] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-mono text-zinc-400">
            <span className="text-zinc-500">SESSION: {session.user.email}</span>

            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1.5 text-zinc-300 hover:text-white underline underline-offset-4 decoration-white/20 hover:decoration-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create another organization</span>
            </Link>
          </div>
        </div>
      </main>

      {/* Engineering Footer */}
      <footer className="relative z-10 border-t border-white/[0.08] bg-[#060608]/85 backdrop-blur-xl py-4 px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
            <span className="text-zinc-400 font-medium">ORGANIZATION_ROUTER</span>
            <span>·</span>
            <span>ROW_MUTEX_VERIFIED</span>
          </div>
          <div>
            <span>MULTI_TENANT // RBAC_SECURED // ZERO_LEAKAGE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
