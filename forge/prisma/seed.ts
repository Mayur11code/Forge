// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Note: We initialize a local client here to avoid path resolution errors during seeding
const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = "admin@forge.com"; 
  const orgSlug = "forge-hq";

  console.log("🚀 Starting seed...");

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Root Admin",
    },
  });

  const org = await prisma.organization.upsert({
    where: { slug: orgSlug },
    update: {},
    create: {
      slug: orgSlug,
      name: "Forge HQ",
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: user.id,
        orgId: org.id,
      },
    },
    update: { role: "ADMIN" },
    create: {
      userId: user.id,
      orgId: org.id,
      role: "ADMIN",
    },
  });

  console.log(`✅ Seeded: User(${user.email}) as ADMIN in Org(${org.slug})`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });