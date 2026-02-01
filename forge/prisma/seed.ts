// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs"; // Import bcrypt for password hashing

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = "admin@forge.com"; 
  const password = "securepassword"; // Use this to log in
  const orgSlug = "forge-hq";

  console.log("🚀 Starting seed...");

  // 1. HASH THE PASSWORD 
  // auth.ts uses bcrypt.compare, so the DB MUST store a hash, not plain text.
  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashedPassword }, // Update password to hash if user exists
    create: {
      email,
      name: "Root Admin",
      password: hashedPassword, // Store the hash
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

  console.log("-----------------------------------------");
  console.log(`✅ Seeded: User(${user.email}) as ADMIN in Org(${org.slug})`);
  console.log(`🔑 Login Email: ${email}`);
  console.log(`🔑 Login Password: ${password}`);
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