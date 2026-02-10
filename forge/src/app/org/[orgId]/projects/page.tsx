import { db } from "@/lib/prisma/db";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import ProjectsMetaRefresh from "@/features/organizations/components/projects/projects-meta-refresh";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function ProjectsPage({ params }: { params: Promise<{ orgId: string }> }) {
    const { orgId } = await params;

    // 1️⃣ Auth + org + membership check (centralized)
    // const { organization, membership } = await requireOrgAccess(orgId);
     const access = await getOrgAccess(orgId);
    if (!access) notFound();
    

    // 2️⃣ Fetch projects scoped to this organization
    const projects = await db.project.findMany({
        where: {
            orgId: access.organization.id,
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

    // META HANDLING FOR NEW PROJECTS UPDATE LIVE TO USER

    const canCreateProject =
        access.membership.role === "ADMIN" || access.membership.role === "MANAGER";

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">
                    Projects · {access.organization.name}
                </h1>

                <ProjectsMetaRefresh
                orgSlug={orgId}
                initialMeta={initialMeta}
            />

                {canCreateProject && (
                    <Link
                        href={`/org/${orgId}/projects/new`}
                        scroll={false}
                        className="rounded-md bg-black px-4 py-2 text-white"
                    >
                        New Project
                    </Link>
                )}

            </div>
            

            {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    No projects created yet.
                </p>
            ) : (
                <ul className="grid gap-4">
                    {projects.map((project) => (
                        <li
                            key={project.id}
                            className="rounded-md border p-4 transition hover:bg-muted/40"
                        >
                            <h2 className="font-medium">{project.name}</h2>

                            {project.description && (
                                <p className="text-sm text-muted-foreground">
                                    {project.description}
                                </p>


                            )}
                            <Link
                                href={`/org/${orgId}/projects/${project.id}`}
                                className="text-sm text-blue-500 hover:underline mt-2 inline-block"
                            >
                                View Tasks &rarr;
                            </Link>

                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
