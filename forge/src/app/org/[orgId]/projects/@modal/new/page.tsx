import { notFound } from "next/navigation";
import { requireOrgAccess } from "@/features/organizations/require-org-access";
import NewProjectForm from "@/features/organizations/components/new-project-form";

export default async function NewProjectModal({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { membership } = await requireOrgAccess((await params).orgId);

  if (membership.role === "MEMBER") {
    notFound();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-lg bg-black p-6 shadow-lg">
        <NewProjectForm orgSlug={(await params).orgId} />
      </div>
    </div>
  );
}
