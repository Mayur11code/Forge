// src/lib/prisma/extended.ts
import { db } from './db'; 
import { publishEvent } from '@/lib/events/queue'; 

export const prisma = db.$extends({
  query: {
    task: {
      // Intercept any task CREATION
async create({ args, query }) {
  const result = await query(args);

  if (result.id) {
    // We must fetch the orgId from the parent Project
    let resolvedOrgId = "default_org"; // Fallback

    if (result.projectId) {
      const parentProject = await db.project.findUnique({
        where: { id: result.projectId },
        select: { orgId: true }
      });
      if (parentProject?.orgId) resolvedOrgId = parentProject.orgId;
    }

    publishEvent("TASK_CREATED", { 
      taskId: result.id, 
      orgId: resolvedOrgId,
      projectId: result.projectId ?? ""
    });
  }

  return result;
},

      // Intercept any task UPDATE
      async update({ args, query }) {
        const result = await query(args);
        
        
  if (result.id) {
    // We must fetch the orgId from the parent Project
    let resolvedOrgId = "default_org"; // Fallback

    if (result.projectId) {
      const parentProject = await db.project.findUnique({
        where: { id: result.projectId },
        select: { orgId: true }
      });
      if (parentProject?.orgId) resolvedOrgId = parentProject.orgId;
    }

    publishEvent("TASK_UPDATED", { 
      taskId: result.id, 
      orgId: resolvedOrgId,
      projectId: result.projectId ?? ""
    });
  }
        return result;
      },

      // Intercept any task DELETION
      async delete({ args, query }) {
        const result = await query(args);
        
        if (result.id) {
          // We must fetch the orgId from the parent Project
          let resolvedOrgId = "default_org"; // Fallback

          if (result.projectId) {
            const parentProject = await db.project.findUnique({
              where: { id: result.projectId },
              select: { orgId: true }
            });
            if (parentProject?.orgId) resolvedOrgId = parentProject.orgId;
          }

          publishEvent("TASK_DELETED", { 
            taskId: result.id, 
            orgId: resolvedOrgId,
            // ADDED: Satisfy the Zod schema requirement
            projectId: result.projectId ?? "" 
          });
        }
        return result;
      }
    }
  }
});

export default prisma;