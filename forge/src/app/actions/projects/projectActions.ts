"use server";

import { z } from "zod";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { revalidatePath } from "next/cache";
import { deleteProjectTransactionally } from "@/lib/deletion/service";

const updateProjectSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  name: z
    .string()
    .trim()
    .min(1, "Project name cannot be empty")
    .max(100, "Project name must be at most 100 characters"),
  description: z
    .string()
    .trim()
    .max(500, "Description must be at most 500 characters")
    .optional()
    .nullable(),
});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/**
 * Updates a project's name and description.
 * Caller must have ADMIN or MANAGER role in the organization.
 */
export async function updateProject(
  orgSlug: string,
  rawInput: UpdateProjectInput
): Promise<{ success: boolean; project?: { id: string; name: string; description: string | null }; error?: string }> {
  try {
    const input = updateProjectSchema.parse(rawInput);
    const access = await getOrgAccess(orgSlug);

    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
      return { success: false, error: "Forbidden: Insufficient permissions to edit project settings" };
    }

    const existing = await db.project.findFirst({
      where: {
        id: input.projectId,
        orgId: access.organization.id,
      },
    });

    if (!existing) {
      return { success: false, error: "Project not found in this organization" };
    }

    const updated = await db.project.update({
      where: { id: input.projectId },
      data: {
        name: input.name,
        description: input.description ?? null,
      },
      select: {
        id: true,
        name: true,
        description: true,
      },
    });

    revalidatePath(`/org/${orgSlug}/projects`);
    revalidatePath(`/org/${orgSlug}/projects/${input.projectId}`);
    return { success: true, project: updated };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to update project",
    };
  }
}

/**
 * Soft-archives a project.
 * Archived projects are filtered out of active views and active workflow engines.
 */
export async function archiveProject(
  orgSlug: string,
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const access = await getOrgAccess(orgSlug);

    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
      return { success: false, error: "Forbidden: Insufficient permissions to archive project" };
    }

    const existing = await db.project.findFirst({
      where: {
        id: projectId,
        orgId: access.organization.id,
      },
    });

    if (!existing) {
      return { success: false, error: "Project not found in this organization" };
    }

    await db.project.update({
      where: { id: projectId },
      data: { archivedAt: new Date() },
    });

    revalidatePath(`/org/${orgSlug}/projects`);
    revalidatePath(`/org/${orgSlug}/projects/${projectId}`);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to archive project",
    };
  }
}

/**
 * Restores an archived project back to active state.
 */
export async function unarchiveProject(
  orgSlug: string,
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const access = await getOrgAccess(orgSlug);

    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
      return { success: false, error: "Forbidden: Insufficient permissions to unarchive project" };
    }

    const existing = await db.project.findFirst({
      where: {
        id: projectId,
        orgId: access.organization.id,
      },
    });

    if (!existing) {
      return { success: false, error: "Project not found in this organization" };
    }

    await db.project.update({
      where: { id: projectId },
      data: { archivedAt: null },
    });

    revalidatePath(`/org/${orgSlug}/projects`);
    revalidatePath(`/org/${orgSlug}/projects/${projectId}`);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to unarchive project",
    };
  }
}

/**
 * Destructively deletes a project and cascades cleanup of child tasks,
 * comments, and external attachment files via the domain deletion outbox.
 *
 * Requires explicit typed confirmation of the project name before proceeding.
 */
export async function deleteProject(
  orgSlug: string,
  projectId: string,
  confirmedName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const access = await getOrgAccess(orgSlug);

    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
      return { success: false, error: "Forbidden: Insufficient permissions to delete project" };
    }

    const project = await db.project.findFirst({
      where: {
        id: projectId,
        orgId: access.organization.id,
      },
      select: { id: true, name: true },
    });

    if (!project) {
      return { success: false, error: "Project not found in this organization" };
    }

    if (confirmedName.trim() !== project.name.trim()) {
      return {
        success: false,
        error: `Confirmation mismatch: expected "${project.name}", received "${confirmedName}"`,
      };
    }

    // Execute atomic transactional deletion with full outbox cleanup & quota adjustments
    await deleteProjectTransactionally(projectId);

    revalidatePath(`/org/${orgSlug}/projects`);
    revalidatePath(`/org/${orgSlug}/dashboard`);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete project",
    };
  }
}
