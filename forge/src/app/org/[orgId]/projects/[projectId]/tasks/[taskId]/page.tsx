// src/app/org/[orgId]/projects/[projectId]/tasks/[taskId]/page.tsx

import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import CommentSection from "@/features/organizations/components/comments/CommentSection";




export default async function TaskDetailPage({
    params,
}: {
    params: Promise<{
        orgId: string;
        projectId: string;
        taskId: string;
    }>;
}) {
    const { orgId, projectId, taskId } = await params;

    // 1️⃣ Verify org access
    const access = await getOrgAccess(orgId);
    if (!access) notFound();

    const orgDbId = access.organization.id;

    // 2️⃣ Verify project belongs to org
    const project = await db.project.findFirst({
        where: {
            id: projectId,
            orgId: orgDbId,
        },
        select: { id: true, name: true },
    });

    if (!project) notFound();

    // 3️⃣ Fetch task + comments
    const task = await db.task.findFirst({
        where: {
            id: taskId,
            projectId: project.id,
        },
        include: {
            assignee: {
                select: {
                    id: true,
                    name: true,

                },
            },
            attachments: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    name: true,
                    size: true,
                    url: true,     // or fileKey if using signed URLs
                    createdAt: true,
                },
            },
            comments: {
                orderBy: { createdAt: "asc" },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,

                        },
                    },
                },
            },
        },

    });

    if (!task) notFound();

    return (
        <div className="max-w-4xl mx-auto space-y-10">

            {/* Task Header */}
            <div className="space-y-3">
                <h1 className="text-3xl font-bold text-white">
                    {task.title}
                </h1>

                <p className="text-zinc-400">
                    {task.description || "No description provided."}
                </p>

                <div className="flex items-center gap-4 text-sm text-zinc-500">
                    <span>Status: {task.status}</span>
                    <span>Priority: {task.priority}</span>
                    <span>
                        Assignee: {task.assignee?.name || "Unassigned"}
                    </span>
                </div>
            </div>

            {/* Attachments Section */}
            <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8">
                <h2 className="text-xl font-semibold text-white mb-6">
                    Attachments
                </h2>

                {task.attachments.length === 0 ? (
                    <p className="text-zinc-500">
                        No attachments uploaded.
                    </p>
                ) : (
                    <div className="space-y-4">
                        {task.attachments.map((file) => (
                            <div
                                key={file.id}
                                className="flex items-center justify-between border-b border-zinc-800 pb-3"
                            >
                                <div>
                                    <p className="text-zinc-300 font-medium">
                                        {file.name}
                                    </p>
                                    <p className="text-zinc-500 text-xs">
                                        {(file.size / 1024).toFixed(1)} KB •{" "}
                                        {new Date(file.createdAt).toLocaleDateString()}
                                    </p>
                                </div>

                                <a
                                    href={file.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 text-sm hover:underline"
                                >
                                    Download
                                </a>
                            </div>
                        ))}
                    </div>
                )}
            </div>


            {/* Discussion Section */}
            {/* Discussion Section */}
            <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8">
                <h2 className="text-xl font-semibold text-white mb-6">
                    Discussion
                </h2>

                <CommentSection
                    orgSlug={orgId}
                    taskId={task.id}
                    initialComments={task.comments}
                />
            </div>


        </div>
    );
}
