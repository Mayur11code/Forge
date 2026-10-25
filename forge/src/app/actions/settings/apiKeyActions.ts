"use server";

import { auth } from "@/lib/auth/auth";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/prisma/db";
import { CredentialPurpose } from "@prisma/client";
import {
  listOrganizationCredentials,
  stageAndActivateCredential,
  revokeOrganizationCredential,
  deleteOrganizationCredential,
  VaultValidationError,
  VaultConcurrencyError,
  type OrganizationCredentialMetadata,
  type KeyValidationResult,
  type ValidationCategory,
} from "@/lib/security/vault";

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  category?: ValidationCategory;
}

const saveApiKeySchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  purpose: z.nativeEnum(CredentialPurpose),
  apiKey: z
    .string()
    .trim()
    .min(8, "API key must be at least 8 characters long")
    .max(512, "API key exceeds maximum length"),
});

const keyTargetSchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  purpose: z.nativeEnum(CredentialPurpose),
});

/**
 * Resolves an orgId or orgSlug to the canonical organization UUID and verifies RBAC.
 */
async function verifyOrgAdminAccess(
  orgIdOrSlug: string,
  sessionUserId: string
): Promise<{ organizationId: string; slug: string }> {
  const org = await db.organization.findFirst({
    where: {
      OR: [{ id: orgIdOrSlug }, { slug: orgIdOrSlug }],
    },
    select: {
      id: true,
      slug: true,
      memberships: {
        where: { userId: sessionUserId },
        select: { role: true },
      },
    },
  });

  if (!org) {
    throw new Error("Organization not found.");
  }

  const membership = org.memberships[0];
  if (!membership) {
    throw new Error("Unauthorized: You are not a member of this organization.");
  }

  if (membership.role !== "ADMIN") {
    throw new Error("Forbidden: Only organization administrators can manage AI provider credentials.");
  }

  return { organizationId: org.id, slug: org.slug };
}

/**
 * Retrieves safe metadata for all credentials configured in the organization.
 */
export async function getOrgApiKeysAction(
  orgIdOrSlug: string
): Promise<ActionResult<OrganizationCredentialMetadata[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized: Please log in." };
    }

    const org = await db.organization.findFirst({
      where: {
        OR: [{ id: orgIdOrSlug }, { slug: orgIdOrSlug }],
      },
      select: {
        id: true,
        memberships: {
          where: { userId: session.user.id },
          select: { role: true },
        },
      },
    });

    if (!org || org.memberships.length === 0) {
      return { success: false, error: "Unauthorized: Organization membership required." };
    }

    const keys = await listOrganizationCredentials(org.id);
    return { success: true, data: keys };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load organization credentials.",
    };
  }
}

/**
 * Validates, encrypts, and stages an organization AI key into ACTIVE status.
 * Safe replacement lifecycle: Preexisting active key remains intact if candidate key validation fails.
 */
export async function saveOrgApiKeyAction(input: {
  orgId: string;
  purpose: CredentialPurpose;
  apiKey: string;
}): Promise<
  ActionResult<{
    metadata: OrganizationCredentialMetadata;
    validation: KeyValidationResult;
  }>
> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized: Please log in." };
    }

    const parsed = saveApiKeySchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid input parameters.",
      };
    }

    const { organizationId, slug } = await verifyOrgAdminAccess(
      parsed.data.orgId,
      session.user.id
    );

    const result = await stageAndActivateCredential({
      orgId: organizationId,
      purpose: parsed.data.purpose,
      apiKey: parsed.data.apiKey,
      userId: session.user.id,
    });

    revalidatePath(`/org/${slug}/settings`);

    return {
      success: true,
      data: {
        metadata: result.metadata,
        validation: result.validationResult,
      },
    };
  } catch (err) {
    if (err instanceof VaultValidationError) {
      return {
        success: false,
        error: err.message,
        category: err.category,
      };
    }
    if (err instanceof VaultConcurrencyError) {
      return {
        success: false,
        error: err.message,
        category: "TRANSIENT_FAILURE",
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save credential.",
    };
  }
}

/**
 * Transitions an active or pending credential to REVOKED status.
 */
export async function revokeOrgApiKeyAction(input: {
  orgId: string;
  purpose: CredentialPurpose;
}): Promise<ActionResult<OrganizationCredentialMetadata>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized: Please log in." };
    }

    const parsed = keyTargetSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: "Invalid parameters." };
    }

    const { organizationId, slug } = await verifyOrgAdminAccess(
      parsed.data.orgId,
      session.user.id
    );

    const metadata = await revokeOrganizationCredential(
      organizationId,
      parsed.data.purpose
    );

    revalidatePath(`/org/${slug}/settings`);

    return { success: true, data: metadata };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to revoke credential.",
    };
  }
}

/**
 * Deletes a credential from the vault.
 */
export async function deleteOrgApiKeyAction(input: {
  orgId: string;
  purpose: CredentialPurpose;
}): Promise<ActionResult<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized: Please log in." };
    }

    const parsed = keyTargetSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: "Invalid parameters." };
    }

    const { organizationId, slug } = await verifyOrgAdminAccess(
      parsed.data.orgId,
      session.user.id
    );

    await deleteOrganizationCredential(organizationId, parsed.data.purpose);

    revalidatePath(`/org/${slug}/settings`);

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete credential.",
    };
  }
}
