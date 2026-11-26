import { redirect } from "next/navigation";

export default async function OrgRootPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/org/${orgId}/dashboard`);
}
