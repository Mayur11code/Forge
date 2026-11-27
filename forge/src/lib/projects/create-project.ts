// src/lib/projects/create-project.ts
//
// FC-018: Canonical Project Creation with Transactional Domain Event Outbox.

import { z } from "zod";
import { prisma } from "@/lib/prisma/extended";
import { type Project } from "@prisma/client";
import {
  recordDomainEventIntent,
  enqueueDomainOutboxWakeup,
  type MutationOrigin,
} from "@/lib/events/domain-outbox";

export const createProjectInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(100, "Project name is too long"),
  description: z
    .string()
    .trim()
    .max(500, "Description is too long")
    .optional()
    .nullable()
    .or(z.literal("")),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export type CreateProjectActor = {
  orgId: string;
  userId?: string;
  origin?: MutationOrigin;
};

export type CreateProjectResult =
  | { success: true; project: Project }
  | { success: false; error: string; code: "INVALID_INPUT" | "CREATE_FAILED" };

/**
 * Canonical domain operation for project creation.
 * Atomically writes the Project row and records the project.created DomainEventOutbox intent.
 */
export async function createProjectInOrg(
  input: unknown,
  actor: CreateProjectActor,
): Promise<CreateProjectResult> {
  const parsed = createProjectInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: parsed.error.issues[0]?.message || "Invalid project input.",
    };
  }

  const data = parsed.data;

  try {
    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name: data.name,
          description: data.description ? data.description : null,
          orgId: actor.orgId,
        },
      });

      await recordDomainEventIntent({
        tx,
        orgId: actor.orgId,
        eventType: "project.created",
        entityType: "PROJECT",
        entityId: created.id,
        payload: {
          projectId: created.id,
          name: created.name,
          description: created.description,
        },
        origin: actor.origin,
      });

      return created;
    });

    if (actor.origin?.originType !== "WORKFLOW") {
      enqueueDomainOutboxWakeup().catch((err) => {
        console.warn("[PROJECT] Fast-path wake-up notification deferred to sweeper:", err);
      });
    }

    return { success: true, project };
  } catch (error) {
    return {
      success: false,
      code: "CREATE_FAILED",
      error: error instanceof Error ? error.message : "Project could not be created.",
    };
  }
}
