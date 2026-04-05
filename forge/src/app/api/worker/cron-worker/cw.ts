import { db } from "@/lib/prisma/db";

export async function cronWorkerHandler() {
  console.log("⏰ [CRON] Running Daily Digest...");

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

  for (const user of usersWithTasks) {
    console.log(
      `✉️ [Email] To: ${user.email} | ${user.tasks.length} tasks`
    );

    user.tasks.forEach((task) => {
      console.log(`   - [${task.project.name}] ${task.title}`);
    });
  }

  console.log("✅ [CRON] Done");
}