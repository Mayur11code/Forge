import { auth } from "@/lib/auth/auth";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import TaskBox from "@/features/organizations/components/Taskbox";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{
    query?: string;
    status?: string;
    priority?: string;
    filter?: string;
  }>;
}) {
  const { orgId } = await params;
  
  // 1. Await the promise once
  const resolvedSearchParams = await searchParams;
  
  console.log("SERVER RERENDER", resolvedSearchParams);

  // 2. Read from the resolved object (No conflict now)
  const query =
    typeof resolvedSearchParams?.query === "string"
      ? resolvedSearchParams.query
      : undefined;

  const status =
    typeof resolvedSearchParams?.status === "string"
      ? resolvedSearchParams.status
      : undefined;

  const priority =
    typeof resolvedSearchParams?.priority === "string"
      ? resolvedSearchParams.priority
      : undefined;

const filter =typeof resolvedSearchParams?.filter === "string" ? resolvedSearchParams.filter : "ALL";


  // 🔐 Auth + org guard
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  
  const session = await auth();

  const organization = await db.organization.findUnique({
    where: { slug: orgId },
  });

  if (!organization) {
    throw new Error("Organization not found");
  }

  // 📦 Fetch ALL tasks across ALL projects in this org
  const tasks = await db.task.findMany({
    where: {
      project: {
        orgId: organization.id,
      },

      ...(status && { status: status as any }),
      ...(priority && { priority: priority as any }),

      ...(query && {
        OR: [
          {
            title: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            description: {
              contains: query,
              mode: "insensitive",
            },
          },
        ],
      }),
...(filter !== "ALL" && { status: filter as any }),
    },

    include: {
      project: {
        select: { id: true, name: true },
      },
    },

    orderBy: { createdAt: "desc" },

    take: 50, // 🔥 IMPORTANT: pagination-ready
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">All Tasks</h1>

      <p className="text-gray-600">
        Logged in as{" "}
        <span className="font-mono text-blue-500">
          {session?.user?.role}
        </span>
      </p>

      <TaskBox
        mode="org"
        param={{ orgId }}
        initialtasks={tasks}
      />
    </div>
  );
}