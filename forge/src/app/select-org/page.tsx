import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma/db";
import Link from "next/link";
import {
  Building2,
  ArrowRight,
  Plus,
  Shield,
  Layers,
  Users,
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl w-full mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-400 mb-1">
            <Building2 className="w-6 h-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Select a workspace
          </h1>
          <p className="text-sm text-zinc-400">
            Choose an organization to view your team projects, workflows, and runs.
          </p>
        </div>

        {/* Organizations Grid */}
        <div className="space-y-3">
          {memberships.map((m) => {
            const org = m.organization;
            const roleFormatted =
              m.role.charAt(0).toUpperCase() + m.role.slice(1).toLowerCase();

            return (
              <div
                key={m.id}
                className="group p-5 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-2xl transition-all duration-200 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700/80 flex items-center justify-center text-lg font-bold text-zinc-300 uppercase shrink-0 group-hover:border-blue-500/40 group-hover:bg-blue-600/10 group-hover:text-blue-400 transition-colors">
                    {org.name.charAt(0) || "O"}
                  </div>

                  <div className="flex flex-col min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white truncate text-base">
                        {org.name}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                        {roleFormatted}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-zinc-400">
                      <span className="font-mono text-zinc-500">
                        /org/{org.slug}
                      </span>
                      <span className="flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5 text-zinc-500" />
                        {org._count.projects} projects
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5 text-zinc-500" />
                        {org._count.memberships} members
                      </span>
                    </div>
                  </div>
                </div>

                <Link
                  href={`/org/${org.slug}/dashboard`}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-lg shadow-blue-600/20 active:scale-[0.98] transition-all shrink-0"
                >
                  <span>Launch</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            );
          })}
        </div>

        {/* Action Bar */}
        <div className="pt-4 border-t border-zinc-800/80 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-400">
          <span>Signed in as {session.user.email}</span>

          <Link
            href="/onboarding"
            className="inline-flex items-center gap-2 font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Create another organization</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
