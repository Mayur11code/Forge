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
  const adminEmail = "admin@forge.com";
  const memberEmail = "member@forge.com";
  const password = "securepassword";

  const hashedPassword = await bcrypt.hash(password, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      password: hashedPassword,
      name: "Mayur Admin",
    },
    create: {
      email: adminEmail,
      name: "Mayur Admin",
      password: hashedPassword,
    },
  });

  const memberUser = await prisma.user.upsert({
    where: { email: memberEmail },
    update: {
      password: hashedPassword,
      name: "Test Member",
    },
    create: {
      email: memberEmail,
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




  // ❌ Admin is NOT a member of other-org (cross-tenant test)
  // ❌ Member is NOT a member of other-org



    // -----------------------------
  // PROJECTS
  // -----------------------------
  await prisma.project.createMany({
    data: [
      {
        name: "Forge Core",
        description: "Main platform and architecture for Forge",
        orgId: forgeOrg.id,
      },
      {
        name: "Auth & RBAC",
        description: "Authentication and role-based access control system",
        orgId: forgeOrg.id,
      },
      {
        name: "Dashboard UI",
        description: "Organization and project dashboard experience",
        orgId: forgeOrg.id,
      },
    ],
    skipDuplicates: true,
  });

  console.log("-----------------------------------------");
  console.log("✅ Seed complete!");
  console.log("");
  console.log("🧪 TEST ACCOUNTS:");
  console.log(`ADMIN  → ${adminEmail} / ${password}`);
  console.log(`MEMBER → ${memberEmail} / ${password}`);
  console.log("");
  console.log("🏢 ORGS:");
  console.log("• forge-hq (admin + member)");
  console.log("• other-org (no memberships)");
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
