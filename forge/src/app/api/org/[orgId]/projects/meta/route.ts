export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { db } from "@/lib/prisma/db";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";

/* ----------------------------------------
   GET /api/org/[orgId]/projects/meta
---------------------------------------- */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  noStore();
  console.log("🔥 META ROUTE HIT");

  // RBAC + tenant isolation
  // const { organization } = await requireOrgAccess((await params).orgId);
   const access = await getOrgAccess((await params).orgId);
  if (!access) notFound();
  const organization = access.organization;

  const [latestProject, totalCount] = await Promise.all([
    db.project.findFirst({
      where: { orgId: organization?.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.project.count({
      where: { orgId: organization?.id },
    }),
  ]);

  return NextResponse.json({
    latestCreatedAt: latestProject?.createdAt ?? null,
    totalCount,
  });
}




