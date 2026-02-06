// prisma/seed.ts
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

  // -----------------------------
  // PROJECTS (capture references)
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
  // TASKS (CORE OF THIS UPDATE)
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
