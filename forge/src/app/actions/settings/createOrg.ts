"use server";

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { Role, TaskStatus, TaskPriority, Prisma } from "@prisma/client";
import { z } from "zod";

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/(^-|-$)/g, "") || "workspace"
  );
}

const createOrgSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Organization name is required")
    .max(50, "Organization name must be 50 characters or less"),
  idempotencyKey: z
    .string()
    .trim()
    .min(8, "Idempotency key must be at least 8 characters")
    .max(100, "Idempotency key must be 100 characters or less")
    .optional(),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export interface CreateOrgResult {
  success: boolean;
  orgId?: string;
  orgSlug?: string;
  redirectUrl?: string;
  error?: string;
}

/**
 * Creates a new organization, assigns caller as ADMIN, and creates a starter project and task.
 * Atomic transaction guarantees no orphaned organization if membership creation fails.
 * Explicit maxWait and timeout handle remote WAN TLS connection acquisition safely.
 * Authoritative idempotency guarantees that replaying a request with the same idempotencyKey
 * returns the existing organization without creating duplicates.
 */
export async function createOrganizationAction(
  input: CreateOrgInput
): Promise<CreateOrgResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      error: "Unauthorized. Please sign in to create an organization.",
    };
  }

  const parsed = createOrgSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message || "Invalid organization name";
    return { success: false, error: message };
  }

  const { name, idempotencyKey } = parsed.data;
  const userId = session.user.id;

  // 1. Authoritative idempotency pre-check
  if (idempotencyKey) {
    const existingOrg = await db.organization.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        slug: true,
        name: true,
        memberships: {
          where: { userId },
          select: { role: true },
        },
      },
    });

    if (existingOrg) {
      if (existingOrg.memberships.length > 0) {
        return {
          success: true,
          orgId: existingOrg.id,
          orgSlug: existingOrg.slug,
          redirectUrl: `/org/${existingOrg.slug}/dashboard`,
        };
      }
      return {
        success: false,
        error: "Idempotency key conflict: This key is already claimed by another user.",
      };
    }
  }

  try {
    const createdOrg = await db.$transaction(
      async (tx) => {
        // Recheck idempotency inside transaction
        if (idempotencyKey) {
          const replayOrg = await tx.organization.findUnique({
            where: { idempotencyKey },
            select: {
              id: true,
              slug: true,
              name: true,
              memberships: {
                where: { userId },
                select: { role: true },
              },
            },
          });

          if (replayOrg) {
            if (replayOrg.memberships.length > 0) {
              return replayOrg;
            }
            throw new Error("IDEMPOTENCY_KEY_CONFLICT");
          }
        }

        // 1. Slug generation with collision resolution
        let slug = slugify(name);
        const existing = await tx.organization.findUnique({
          where: { slug },
          select: { id: true },
        });

        if (existing) {
          const randomSuffix = Math.random().toString(36).substring(2, 6);
          slug = `${slug}-${randomSuffix}`;
        }

        // 2. Create Organization record with idempotencyKey
        const org = await tx.organization.create({
          data: {
            name,
            slug,
            idempotencyKey: idempotencyKey || null,
          },
          select: {
            id: true,
            slug: true,
            name: true,
          },
        });

        // 3. Create ADMIN Membership for creator
        await tx.membership.create({
          data: {
            userId,
            orgId: org.id,
            role: Role.ADMIN,
          },
        });

        // 4. Create starter Project
        const project = await tx.project.create({
          data: {
            name: "General",
            description: "Default workspace project for your team.",
            orgId: org.id,
          },
        });

        // 5. Create starter Task
        await tx.task.create({
          data: {
            title: "Welcome to Forge! Explore your workspace",
            description:
              "Your organization is ready. You can build visual workflows, create tasks, and invite colleagues.",
            status: TaskStatus.TODO,
            priority: TaskPriority.MEDIUM,
            projectId: project.id,
            assigneeId: userId,
          },
        });

        return org;
      },
      {
        maxWait: 10000, // 10s budget to acquire connection from pool (sufficient for WAN + cold start)
        timeout: 15000, // 15s budget for interactive transaction execution
      }
    );

    return {
      success: true,
      orgId: createdOrg.id,
      orgSlug: createdOrg.slug,
      redirectUrl: `/org/${createdOrg.slug}/dashboard`,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Unique constraint violation (e.g. concurrent submission with same idempotencyKey or slug)
      if (idempotencyKey) {
        const raceOrg = await db.organization.findUnique({
          where: { idempotencyKey },
          select: {
            id: true,
            slug: true,
            memberships: {
              where: { userId },
              select: { role: true },
            },
          },
        });
        if (raceOrg && raceOrg.memberships.length > 0) {
          return {
            success: true,
            orgId: raceOrg.id,
            orgSlug: raceOrg.slug,
            redirectUrl: `/org/${raceOrg.slug}/dashboard`,
          };
        }
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[createOrganizationAction] Transaction failed:", errMsg);

    if (errMsg.includes("IDEMPOTENCY_KEY_CONFLICT")) {
      return {
        success: false,
        error: "Idempotency key conflict: This key is already claimed by another user.",
      };
    }

    if (errMsg.includes("Unable to start a transaction") || errMsg.includes("timeout")) {
      return {
        success: false,
        error: "Database connection timeout. Please check your connection and retry.",
      };
    }

    return {
      success: false,
      error: "Failed to create organization. Please try again.",
    };
  }
}
