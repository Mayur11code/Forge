"use server";

import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { Role } from "@prisma/client";
import { revalidatePath } from "next/cache";

export interface MemberActionResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Updates a team member's role within an organization.
 * Strictly enforces ADMIN authorization, tenant scoping, and last-admin safeguard.
 */
export async function updateMemberRole(
  orgSlug: string,
  memberId: string,
  newRole: Role
): Promise<MemberActionResult> {
  // 1. Authenticate caller and verify ADMIN access
  const access = await getOrgAccess(orgSlug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  if (access.membership.role !== Role.ADMIN) {
    return {
      success: false,
      error: "Forbidden: Only administrators can update member roles.",
    };
  }

  const orgId = access.organization.id;

  try {
    return await db.$transaction(
      async (tx) => {
        // 2. Organization-level mutex row lock (serializes all concurrent membership mutations)
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId} FOR UPDATE;`;

        // 3. Re-verify caller membership and role inside transaction after acquiring the lock
        const callerMembership = await tx.membership.findFirst({
          where: {
            userId: access.userId,
            orgId,
          },
          select: { role: true },
        });

        if (!callerMembership || callerMembership.role !== Role.ADMIN) {
          return {
            success: false,
            error: "Forbidden: Only administrators can update member roles.",
          };
        }

        // 4. Fetch target membership strictly scoped to this organization
        const targetMembership = await tx.membership.findFirst({
          where: {
            id: memberId,
            orgId,
          },
        });

        if (!targetMembership) {
          return {
            success: false,
            error: "Member not found in this organization.",
          };
        }

        // 5. Authoritative Last-Admin Demotion Safeguard (re-counted after acquiring lock)
        if (targetMembership.role === Role.ADMIN && newRole !== Role.ADMIN) {
          const adminCount = await tx.membership.count({
            where: {
              orgId,
              role: Role.ADMIN,
            },
          });

          if (adminCount <= 1) {
            return {
              success: false,
              error: "Cannot demote the sole administrator of an organization.",
            };
          }
        }

        // 6. Apply role update
        await tx.membership.update({
          where: { id: memberId },
          data: { role: newRole },
        });

        revalidatePath(`/org/${orgSlug}/members`);
        return {
          success: true,
          message: `Member role updated to ${newRole}.`,
        };
      },
      {
        maxWait: 10000,
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error(
      "[updateMemberRole] Failure:",
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: "An unexpected error occurred while updating member role.",
    };
  }
}

/**
 * Removes a member from an organization.
 * Strictly enforces ADMIN authorization, tenant scoping, and last-admin safeguard.
 * Serialized via organization-level row lock.
 */
export async function removeMember(
  orgSlug: string,
  memberId: string
): Promise<MemberActionResult> {
  // 1. Authenticate caller and verify ADMIN access
  const access = await getOrgAccess(orgSlug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  if (access.membership.role !== Role.ADMIN) {
    return {
      success: false,
      error: "Forbidden: Only administrators can remove members.",
    };
  }

  const orgId = access.organization.id;

  try {
    return await db.$transaction(
      async (tx) => {
        // 2. Organization-level mutex row lock (serializes all concurrent membership mutations)
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId} FOR UPDATE;`;

        // 3. Re-verify caller membership and role inside transaction after acquiring the lock
        const callerMembership = await tx.membership.findFirst({
          where: {
            userId: access.userId,
            orgId,
          },
          select: { role: true },
        });

        if (!callerMembership || callerMembership.role !== Role.ADMIN) {
          return {
            success: false,
            error: "Forbidden: Only administrators can remove members.",
          };
        }

        // 4. Fetch target membership strictly scoped to this organization
        const targetMembership = await tx.membership.findFirst({
          where: {
            id: memberId,
            orgId,
          },
        });

        if (!targetMembership) {
          return {
            success: false,
            error: "Member not found in this organization.",
          };
        }

        // 5. Authoritative Last-Admin Removal Safeguard (re-counted after acquiring lock)
        if (targetMembership.role === Role.ADMIN) {
          const adminCount = await tx.membership.count({
            where: {
              orgId,
              role: Role.ADMIN,
            },
          });

          if (adminCount <= 1) {
            return {
              success: false,
              error: "Cannot remove the sole administrator of an organization.",
            };
          }
        }

        // 6. Delete membership (revokes access immediately)
        await tx.membership.delete({
          where: { id: memberId },
        });

        revalidatePath(`/org/${orgSlug}/members`);
        return {
          success: true,
          message: "Member removed from organization successfully.",
        };
      },
      {
        maxWait: 10000,
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error(
      "[removeMember] Failure:",
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: "An unexpected error occurred while removing member.",
    };
  }
}
