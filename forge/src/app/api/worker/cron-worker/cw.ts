import { db } from "@/lib/prisma/db";

export async function cronWorkerHandler() {
  const usersWithTasks = await db.user.findMany({
    where: {
      tasks: {
        some: {
          status: { in: ["TODO", "IN_PROGRESS"] },
        },
      },
    },
    include: {
      tasks: {
        where: {
          status: { in: ["TODO", "IN_PROGRESS"] },
        },
        include: { project: true },
      },
    },
  });

  // Do not log recipient email addresses, project names, or task titles: the
  // digest is per-user PII and the previous per-user logging disclosed it to
  // the log sink. A single aggregate count is enough to confirm the run.
  console.log(`[CRON] Daily digest: ${usersWithTasks.length} user(s)`);
}