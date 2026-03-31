import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🚀 Starting seed...");

  // -----------------------------
  // USERS
  // -----------------------------
  const password = "securepassword";
  const hashedPassword = await bcrypt.hash(password, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@forge.com" },
    update: {},
    create: {
      email: "admin@forge.com",
      name: "Mayur Admin",
      password: hashedPassword,
    },
  });

  const memberUser = await prisma.user.upsert({
    where: { email: "member@forge.com" },
    update: {},
    create: {
      email: "member@forge.com",
      name: "Test Member",
      password: hashedPassword,
    },
  });

  const outsiderUser = await prisma.user.upsert({
    where: { email: "outsider@forge.com" },
    update: {},
    create: {
      email: "outsider@forge.com",
      name: "Outside User",
      password: hashedPassword,
    },
  });

  // -----------------------------
  // ORGANIZATIONS
  // -----------------------------
  const forgeOrg = await prisma.organization.upsert({
    where: { slug: "forge-hq" },
    update: {},
    create: {
      slug: "forge-hq",
      name: "Forge HQ",
    },
  });

  const otherOrg = await prisma.organization.upsert({
    where: { slug: "other-org" },
    update: {},
    create: {
      slug: "other-org",
      name: "Other Organization",
    },
  });

  // -----------------------------
  // MEMBERSHIPS
  // -----------------------------
  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: adminUser.id,
        orgId: forgeOrg.id,
      },
    },
    update: { role: "ADMIN" },
    create: {
      userId: adminUser.id,
      orgId: forgeOrg.id,
      role: "ADMIN",
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: memberUser.id,
        orgId: forgeOrg.id,
      },
    },
    update: { role: "MEMBER" },
    create: {
      userId: memberUser.id,
      orgId: forgeOrg.id,
      role: "MEMBER",
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: outsiderUser.id,
        orgId: otherOrg.id,
      },
    },
    update: { role: "MEMBER" },
    create: {
      userId: outsiderUser.id,
      orgId: otherOrg.id,
      role: "MEMBER",
    },
  });

  // -----------------------------
  // PROJECTS
  // -----------------------------
  const forgeCore = await prisma.project.upsert({
    where: { name_orgId: { name: "Forge Core", orgId: forgeOrg.id } },
    update: {},
    create: {
      name: "Forge Core",
      description: "Main platform and architecture for Forge",
      orgId: forgeOrg.id,
    },
  });

  const authProject = await prisma.project.upsert({
    where: { name_orgId: { name: "Auth & RBAC", orgId: forgeOrg.id } },
    update: {},
    create: {
      name: "Auth & RBAC",
      description: "Authentication and authorization system",
      orgId: forgeOrg.id,
    },
  });

  // -----------------------------
  // TASKS (FIXED POSITION ✅)
  // -----------------------------
  await prisma.task.createMany({
    data: [
      {
        title: "Design event-driven architecture",
        status: "IN_PROGRESS",
        priority: "HIGH",
        projectId: forgeCore.id,
        assigneeId: adminUser.id,
      },
      {
        title: "Set up optimistic UI flow",
        status: "TODO",
        priority: "HIGH",
        projectId: forgeCore.id,
        assigneeId: adminUser.id,
      },
      {
        title: "Implement RBAC middleware",
        status: "IN_PROGRESS",
        priority: "MEDIUM",
        projectId: authProject.id,
        assigneeId: adminUser.id,
      },
      {
        title: "Write permission tests",
        status: "TODO",
        priority: "LOW",
        projectId: authProject.id,
        assigneeId: memberUser.id,
      },
      {
        title: "Audit login flow",
        status: "DONE",
        priority: "MEDIUM",
        projectId: authProject.id,
        assigneeId: memberUser.id,
      },
    ],
    skipDuplicates: true,
  });

  // -----------------------------
  // FETCH TASKS (AFTER CREATION ✅)
  // -----------------------------
  const tasks = await prisma.task.findMany({
    take: 3,
    orderBy: { createdAt: "asc" },
  });

  // -----------------------------
  // ATTACHMENTS
  // -----------------------------
  if (tasks.length === 0) {
    console.warn("⚠️ No tasks found, skipping attachment seed");
  } else {
    await prisma.attachment.createMany({
      data: [
        {
          taskId: tasks[0].id,
          name: "architecture-overview.pdf",
          url: "https://utfs.io/f/architecture-overview.pdf",
          size: 1245000,
        },
        {
          taskId: tasks[0].id,
          name: "event-flow-diagram.png",
          url: "https://utfs.io/f/event-flow-diagram.png",
          size: 842000,
        },
        {
          taskId: tasks[1]?.id || tasks[0].id,
          name: "rbac-matrix.pdf",
          url: "https://utfs.io/f/rbac-matrix.pdf",
          size: 560000,
        },
      ],
    });
  }

  console.log("-----------------------------------------");
  console.log("✅ Seed complete!");
  console.log("");
  console.log("🧪 TEST ACCOUNTS:");
  console.log("ADMIN  → admin@forge.com / securepassword");
  console.log("MEMBER → member@forge.com / securepassword");
  console.log("");
  console.log("🏢 ORGS:");
  console.log("• forge-hq (projects + tasks)");
  console.log("• other-org (empty, isolation test)");
  console.log("-----------------------------------------");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });