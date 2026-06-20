// src/lib/prisma/extended.ts
import { db } from './db'; 
// MAKE SURE THIS PATH MATCHES WHERE YOUR dispatchEvent LIVES
import { dispatchEvent } from '@/lib/events/event-bus'; 

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

          await dispatchEvent("TASK_DELETED", { 
            taskId: result.id, 
            orgId: resolvedOrgId,
            projectId: result.projectId ?? "",
            userId: "system-cdc",
            subject: "Task Deleted",
            body: `Task "${result.title}" has been permanently removed.`
          });
        }
        return result;
      }
    }
  }
});

export default prisma;