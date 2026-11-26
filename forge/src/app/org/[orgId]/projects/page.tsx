import { db } from "@/lib/prisma/db";
import ProjectsMetaRefresh from "@/features/organizations/components/projects/projects-meta-refresh";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import Link from "next/link";
import { notFound } from "next/navigation";
import ProjectSettingsModal from "@/features/projects/components/ProjectSettingsModal";
import { Archive, Folder, Plus } from "lucide-react";

export default async function ProjectsPage({
    params,
    searchParams,
}: {
    params: Promise<{ orgId: string }>;
    searchParams?: Promise<{ view?: string }>;
}) {
    const { orgId } = await params;
    const resolvedSearchParams = await searchParams;
    const view = resolvedSearchParams?.view === "archived" ? "archived" : "active";
    const isArchivedView = view === "archived";

    // 1️⃣ Auth + org + membership check (centralized)
    const access = await getOrgAccess(orgId);
    if (!access) notFound();

    // 2️⃣ Fetch projects scoped to this organization based on archival view
    const projects = await db.project.findMany({
        where: {
            orgId: access.organization.id,
            archivedAt: isArchivedView ? { not: null } : null,
        },
        orderBy: {
            createdAt: "desc",
        },
    });

    const initialMeta = {
        latestCreatedAt: projects[0]?.createdAt
            ? projects[0].createdAt.toISOString()
            : null,
        totalCount: projects.length,
    };

    const canManageProjects =
        access.membership.role === "ADMIN" || access.membership.role === "MANAGER";

    return (
        <div className="p-6 space-y-6 max-w-7xl mx-auto animate-in fade-in duration-300">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                        <Folder className="w-6 h-6 text-zinc-400" />
                        Projects
                        <span className="text-sm font-normal text-zinc-400">· {access.organization.name}</span>
                    </h1>
                    <p className="text-xs text-zinc-400 mt-1">
                        Manage workspaces, tasks, and collaboration across your organization.
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <ProjectsMetaRefresh orgSlug={orgId} initialMeta={initialMeta} />

                    {canManageProjects && (
                        <Link
                            href={`/org/${orgId}/projects/new`}
                            scroll={false}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors shadow-sm"
                        >
                            <Plus className="w-4 h-4" />
                            New Project
                        </Link>
                    )}
                </div>
            </div>

            {/* View Tabs: Active vs Archived */}
            <div className="flex items-center gap-2">
                <Link
                    href={`/org/${orgId}/projects`}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        !isArchivedView
                            ? "bg-zinc-800 text-white shadow-sm"
                            : "text-zinc-400 hover:text-zinc-200"
                    }`}
                >
                    Active Projects
                </Link>
                <Link
                    href={`/org/${orgId}/projects?view=archived`}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        isArchivedView
                            ? "bg-zinc-800 text-white shadow-sm"
                            : "text-zinc-400 hover:text-zinc-200"
                    }`}
                >
                    <Archive className="w-3.5 h-3.5" />
                    Archived
                </Link>
            </div>

            {/* Project List */}
            {projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
                    <Folder className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
                    <p className="text-sm font-medium text-zinc-300">
                        {isArchivedView ? "No archived projects" : "No projects created yet"}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">
                        {isArchivedView
                            ? "Projects archived by admins will appear here."
                            : "Get started by creating your team's first project."}
                    </p>
                </div>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {projects.map((project) => (
                        <div
                            key={project.id}
                            className="group relative flex flex-col justify-between rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-5 transition-all duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/40"
                        >
                            <div className="space-y-2">
                                <div className="flex items-start justify-between gap-2">
                                    <h2 className="font-semibold text-zinc-100 group-hover:text-blue-400 transition-colors">
                                        {project.name}
                                    </h2>

                                    {project.archivedAt && (
                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                                            Archived
                                        </span>
                                    )}
                                </div>

                                <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                                    {project.description || "No description provided."}
                                </p>
                            </div>

                            <div className="flex items-center justify-between pt-4 mt-4 border-t border-zinc-800/60 text-xs">
                                <Link
                                    href={`/org/${orgId}/projects/${project.id}`}
                                    className="font-medium text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                    View Tasks &rarr;
                                </Link>

                                {canManageProjects && (
                                    <ProjectSettingsModal
                                        orgSlug={orgId}
                                        project={project}
                                    />
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
