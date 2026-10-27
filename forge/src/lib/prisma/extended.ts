// src/lib/prisma/extended.ts
import { db } from './db'; 
// MAKE SURE THIS PATH MATCHES WHERE YOUR dispatchEvent LIVES
import { dispatchEvent } from '@/lib/events/event-bus'; 

/**
 * Prisma Client Extension.
 *
 * NOTE ON DELETION ATOMICITY:
 * Standalone Prisma query extensions (prisma.task.delete / prisma.project.delete)
 * execute after or around individual queries. They CANNOT guarantee transaction atomicity
 * between the database deletion and durable outbox event persistence when called outside
 * an explicit db.$transaction.
 *
 * For guaranteed transactional atomicity where database deletions, child cascades,
 * quota adjustments, and outbox cleanup intents commit atomically in a single PostgreSQL
 * transaction, all application-level deletion operations MUST use:
 * - deleteTaskTransactionally(taskId)
 * - deleteProjectTransactionally(projectId)
 * - deleteAttachmentTransactionally(attachmentId, userId)
 * from @/lib/deletion/service.
 *
 * The delete query extensions below serve as CDC interceptors for direct/legacy Prisma
 * callers, capturing relations and notifying the event bus (analytics, notifications).
 */
export const prisma = db.$extends({
  query: {
    task: {
      // ---------------------------------------------
      // Intercept any task CREATION
      // ---------------------------------------------
      async create({ args, query }) {
        const result = await query(args);

        if (result.id) {
          let resolvedOrgId = "default_org";

          if (result.projectId) {
            const parentProject = await db.project.findUnique({
              where: { id: result.projectId },
              select: { orgId: true }
            });
            if (parentProject?.orgId) resolvedOrgId = parentProject.orgId;
          }

          // Fire the centralized Dispatcher instead of publishEvent
          await dispatchEvent("TASK_CREATED", { 
            taskId: result.id, 
            orgId: resolvedOrgId,
            projectId: result.projectId ?? "",
            // Provide fallbacks for the centralized bus requirements
            userId: "system-cdc", 
            subject: "New Task Created",
            body: `A new task "${result.title}" has been added.`
          });
        }

        return result;
      },

      // ---------------------------------------------
      // Intercept any task UPDATE
      // ---------------------------------------------
      async update({ args, query }) {
        const result = await query(args);
        
        if (result.id) {
          let resolvedOrgId = "default_org";

          if (result.projectId) {
            const parentProject = await db.project.findUnique({
              where: { id: result.projectId },
              select: { orgId: true }
            });
            if (parentProject?.orgId) resolvedOrgId = parentProject.orgId;
          }

          await dispatchEvent("TASK_UPDATED", { 
            taskId: result.id, 
            orgId: resolvedOrgId,
            projectId: result.projectId ?? "",
            userId: "system-cdc",
            subject: "Task Updated",
            body: `Task "${result.title}" has been modified.`
          });
        }
        return result;
      },

      // ---------------------------------------------
      // Intercept any task DELETION
      // ---------------------------------------------
      async delete({ args, query }) {
        const taskToDelete = await db.task.findUnique({
          where: args.where,
          select: {
            id: true,
            title: true,
            projectId: true,
            project: { select: { orgId: true } },
            attachments: { select: { id: true, fileKey: true, size: true } },
          },
        });

        const result = await query(args);

        const taskId = result?.id ?? taskToDelete?.id;
        if (taskId) {
          const resolvedOrgId = taskToDelete?.project?.orgId ?? "default_org";
          const resolvedProjectId = result?.projectId ?? taskToDelete?.projectId ?? "";
          const attachmentIds = taskToDelete?.attachments?.map((a) => a.id) ?? [];

          const dispatchResult = await dispatchEvent("TASK_DELETED", {
            taskId,
            orgId: resolvedOrgId,
            projectId: resolvedProjectId,
            userId: "system-cdc",
            subject: "Task Deleted",
            body: `Task "${result?.title ?? taskToDelete?.title ?? taskId}" has been permanently removed.`,
            attachmentIds,
          });

          if (!dispatchResult.ok) {
            const firstErr = dispatchResult.errors[0];
            throw new Error(
              `Failed to publish deletion event for task ${taskId}: ${
                firstErr instanceof Error ? firstErr.message : String(firstErr)
              }`
            );
          }
        }
        return result;
      }
    },
    project: {
      // ---------------------------------------------
      // Intercept project DELETION (cascade cleanup)
      // ---------------------------------------------
      async delete({ args, query }) {
        const projectToDelete = await db.project.findUnique({
          where: args.where,
          select: {
            id: true,
            orgId: true,
            tasks: {
              select: {
                id: true,
                attachments: { select: { id: true, fileKey: true, size: true } },
              },
            },
          },
        });

        const result = await query(args);

        if (projectToDelete && projectToDelete.tasks.length > 0) {
          for (const task of projectToDelete.tasks) {
            await dispatchEvent("TASK_DELETED", {
              taskId: task.id,
              orgId: projectToDelete.orgId,
              projectId: projectToDelete.id,
              userId: "system-cdc",
              subject: "Task Deleted via Project Cascade",
              body: `Task "${task.id}" has been removed via project deletion.`,
              attachmentIds: task.attachments.map((a) => a.id),
            });
          }
        }

        return result;
      }
    }
  }
});

export default prisma;