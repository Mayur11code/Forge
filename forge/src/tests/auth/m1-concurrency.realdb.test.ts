// src/tests/auth/m1-concurrency.realdb.test.ts
//
// Level E3 Real PostgreSQL Concurrency & Serialization Acceptance Test Suite
// Verifies:
// 1. Organization creation idempotency under replay and multi-org support.
// 2. Organization row lock mutex serialization for member mutations.
// 3. Tests A-E: Last-admin protection under genuine concurrent interleaving.
//
// Run with:
//   npx jest --config jest.realdb.config.ts src/tests/auth/m1-concurrency.realdb.test.ts

jest.mock("server-only", () => ({}));
jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { createOrganizationAction } from "@/app/actions/settings/createOrg";
import { updateMemberRole, removeMember } from "@/app/actions/user/memberActions";
import { Role } from "@prisma/client";

jest.setTimeout(180_000);

const RUN_ID = `m1_conc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

describe("M1 Real PostgreSQL Concurrency & Serialization Suite (Level E3)", () => {
  const usersToCleanup: string[] = [];
  const orgsToCleanup: string[] = [];

  // Helper to create a user directly in Postgres
  async function createFixtureUser(emailPrefix: string, name: string) {
    const user = await db.user.create({
      data: {
        email: `${RUN_ID}_${emailPrefix}@example.com`,
        name,
        password: "hashed_test_password",
      },
    });
    usersToCleanup.push(user.id);
    return user;
  }

  // Helper to create an organization directly in Postgres
  async function createFixtureOrg(slugPrefix: string, name: string) {
    const org = await db.organization.create({
      data: {
        slug: `${RUN_ID}_${slugPrefix}`,
        name,
      },
    });
    orgsToCleanup.push(org.id);
    return org;
  }

  afterAll(async () => {
    // Cascade cleanup in foreign key dependency order
    if (orgsToCleanup.length > 0) {
      await db.task.deleteMany({
        where: { project: { orgId: { in: orgsToCleanup } } },
      });
      await db.project.deleteMany({
        where: { orgId: { in: orgsToCleanup } },
      });
      await db.invitation.deleteMany({
        where: { orgId: { in: orgsToCleanup } },
      });
      await db.membership.deleteMany({
        where: { orgId: { in: orgsToCleanup } },
      });
      await db.organization.deleteMany({
        where: { id: { in: orgsToCleanup } },
      });
    }

    if (usersToCleanup.length > 0) {
      await db.membership.deleteMany({
        where: { userId: { in: usersToCleanup } },
      });
      await db.user.deleteMany({
        where: { id: { in: usersToCleanup } },
      });
    }
  });

  // =========================================================================
  // Section 1: Organization Creation & Authoritative Idempotency
  // =========================================================================
  describe("Organization Creation & Idempotency (Real Postgres)", () => {
    it("creates an organization and returns existing record upon idempotency replay", async () => {
      const founder = await createFixtureUser("founder1", "Founder One");
      (auth as jest.Mock).mockResolvedValue({ user: { id: founder.id } });

      const idempotencyKey = `idem_${RUN_ID}_first_org`;

      // 1. First submission
      const res1 = await createOrganizationAction({
        name: `Acme Corp ${RUN_ID}`,
        idempotencyKey,
      });

      expect(res1.success).toBe(true);
      expect(res1.orgId).toBeDefined();
      if (res1.orgId) orgsToCleanup.push(res1.orgId);

      // Verify DB artifacts
      const orgInDb = await db.organization.findUnique({
        where: { id: res1.orgId },
        include: {
          memberships: true,
          projects: { include: { tasks: true } },
        },
      });

      expect(orgInDb).not.toBeNull();
      expect(orgInDb?.idempotencyKey).toBe(idempotencyKey);
      expect(orgInDb?.memberships).toHaveLength(1);
      expect(orgInDb?.memberships[0].userId).toBe(founder.id);
      expect(orgInDb?.memberships[0].role).toBe(Role.ADMIN);
      expect(orgInDb?.projects).toHaveLength(1);
      expect(orgInDb?.projects[0].tasks).toHaveLength(1);

      // 2. Replay with identical idempotency key
      const res2 = await createOrganizationAction({
        name: `Acme Corp ${RUN_ID}`,
        idempotencyKey,
      });

      expect(res2.success).toBe(true);
      expect(res2.orgId).toBe(res1.orgId);
      expect(res2.orgSlug).toBe(res1.orgSlug);

      // Verify no duplicate projects or tasks were created on replay
      const orgAfterReplay = await db.organization.findUnique({
        where: { id: res1.orgId },
        include: {
          memberships: true,
          projects: { include: { tasks: true } },
        },
      });
      expect(orgAfterReplay?.memberships).toHaveLength(1);
      expect(orgAfterReplay?.projects).toHaveLength(1);
      expect(orgAfterReplay?.projects[0].tasks).toHaveLength(1);
    });

    it("allows the same user to create a second intentional organization with a different key", async () => {
      const founder = await createFixtureUser("founder2", "Founder Two");
      (auth as jest.Mock).mockResolvedValue({ user: { id: founder.id } });

      const res1 = await createOrganizationAction({
        name: `Org Alpha ${RUN_ID}`,
        idempotencyKey: `idem_${RUN_ID}_alpha`,
      });
      expect(res1.success).toBe(true);
      if (res1.orgId) orgsToCleanup.push(res1.orgId);

      const res2 = await createOrganizationAction({
        name: `Org Beta ${RUN_ID}`,
        idempotencyKey: `idem_${RUN_ID}_beta`,
      });
      expect(res2.success).toBe(true);
      if (res2.orgId) orgsToCleanup.push(res2.orgId);

      expect(res1.orgId).not.toBe(res2.orgId);

      const userMemberships = await db.membership.findMany({
        where: { userId: founder.id },
      });
      expect(userMemberships).toHaveLength(2);
      expect(userMemberships.map((m) => m.role)).toEqual([Role.ADMIN, Role.ADMIN]);
    });
  });

  // =========================================================================
  // Section 2: Administrator Concurrency & Row Lock Serialization (Tests A-E)
  // =========================================================================
  describe("Administrator Mutex Serialization Tests (A through E)", () => {
    // TEST A: Two simultaneous demotions
    it("Test A: serializes concurrent demotions so exactly one ADMIN remains", async () => {
      const adminA = await createFixtureUser("admin_a", "Admin A");
      const adminB = await createFixtureUser("admin_b", "Admin B");
      const org = await createFixtureOrg("test_a", "Test A Org");

      const memA = await db.membership.create({
        data: { userId: adminA.id, orgId: org.id, role: Role.ADMIN },
      });
      const memB = await db.membership.create({
        data: { userId: adminB.id, orgId: org.id, role: Role.ADMIN },
      });

      // Caller is Admin A (authenticated)
      (auth as jest.Mock).mockResolvedValue({
        user: { id: adminA.id },
      });

      // Concurrent attempts to demote both admins:
      // Request 1: Admin A demotes Admin B
      // Request 2: Admin A demotes Admin A
      const reqDemoteB = updateMemberRole(org.slug, memB.id, Role.MEMBER);
      const reqDemoteA = updateMemberRole(org.slug, memA.id, Role.MEMBER);

      const [resB, resA] = await Promise.all([reqDemoteB, reqDemoteA]);

      // Exactly one must succeed, and the other must be rejected by the last-admin guard or caller privilege revocation
      const successCount = [resA.success, resB.success].filter(Boolean).length;
      expect(successCount).toBe(1);

      const failedRes = resA.success ? resB : resA;
      expect(
        failedRes.error?.includes("Cannot demote the sole administrator") ||
        failedRes.error?.includes("Forbidden")
      ).toBe(true);

      // Verify real PostgreSQL state: exactly 1 ADMIN exists
      const remainingAdmins = await db.membership.findMany({
        where: { orgId: org.id, role: Role.ADMIN },
      });
      expect(remainingAdmins).toHaveLength(1);

      // Verify that subsequent attempt to demote the sole remaining admin returns the last-admin error
      (auth as jest.Mock).mockResolvedValue({ user: { id: remainingAdmins[0].userId } });
      const lastDemoteAttempt = await updateMemberRole(org.slug, remainingAdmins[0].id, Role.MEMBER);
      expect(lastDemoteAttempt.success).toBe(false);
      expect(lastDemoteAttempt.error).toContain("Cannot demote the sole administrator");
    });

    // TEST B: Two simultaneous removals
    it("Test B: serializes concurrent member removals so exactly one ADMIN remains", async () => {
      const adminA = await createFixtureUser("admin_b1", "Admin B1");
      const adminB = await createFixtureUser("admin_b2", "Admin B2");
      const org = await createFixtureOrg("test_b", "Test B Org");

      const memA = await db.membership.create({
        data: { userId: adminA.id, orgId: org.id, role: Role.ADMIN },
      });
      const memB = await db.membership.create({
        data: { userId: adminB.id, orgId: org.id, role: Role.ADMIN },
      });

      (auth as jest.Mock).mockResolvedValue({ user: { id: adminA.id } });

      // Request 1: Admin A removes Admin B
      // Request 2: Admin A removes Admin A
      const reqRemoveB = removeMember(org.slug, memB.id);
      const reqRemoveA = removeMember(org.slug, memA.id);

      const [resB, resA] = await Promise.all([reqRemoveB, reqRemoveA]);

      const successCount = [resA.success, resB.success].filter(Boolean).length;
      expect(successCount).toBe(1);

      const failedRes = resA.success ? resB : resA;
      expect(
        failedRes.error?.includes("Cannot remove the sole administrator") ||
        failedRes.error?.includes("Forbidden")
      ).toBe(true);

      const remainingAdmins = await db.membership.findMany({
        where: { orgId: org.id, role: Role.ADMIN },
      });
      expect(remainingAdmins).toHaveLength(1);

      // Verify that subsequent attempt to remove the sole remaining admin returns the last-admin error
      (auth as jest.Mock).mockResolvedValue({ user: { id: remainingAdmins[0].userId } });
      const lastRemoveAttempt = await removeMember(org.slug, remainingAdmins[0].id);
      expect(lastRemoveAttempt.success).toBe(false);
      expect(lastRemoveAttempt.error).toContain("Cannot remove the sole administrator");
    });

    // TEST C: Mixed concurrent demotion and removal
    it("Test C: handles mixed concurrent demotion and removal safely", async () => {
      const adminA = await createFixtureUser("admin_c1", "Admin C1");
      const adminB = await createFixtureUser("admin_c2", "Admin C2");
      const org = await createFixtureOrg("test_c", "Test C Org");

      const memA = await db.membership.create({
        data: { userId: adminA.id, orgId: org.id, role: Role.ADMIN },
      });
      const memB = await db.membership.create({
        data: { userId: adminB.id, orgId: org.id, role: Role.ADMIN },
      });

      (auth as jest.Mock).mockResolvedValue({ user: { id: adminA.id } });

      // Demote A and Remove B simultaneously
      const reqDemote = updateMemberRole(org.slug, memA.id, Role.MEMBER);
      const reqRemove = removeMember(org.slug, memB.id);

      const [resDemote, resRemove] = await Promise.all([reqDemote, reqRemove]);

      const successCount = [resDemote.success, resRemove.success].filter(Boolean).length;
      expect(successCount).toBe(1);

      const remainingAdmins = await db.membership.findMany({
        where: { orgId: org.id, role: Role.ADMIN },
      });
      expect(remainingAdmins.length).toBeGreaterThanOrEqual(1);
    });

    // TEST D: Non-admin caller rejection
    it("Test D: rejects MEMBER and MANAGER callers attempting protected operations", async () => {
      const memberUser = await createFixtureUser("caller_mem", "Member User");
      const managerUser = await createFixtureUser("caller_mgr", "Manager User");
      const targetUser = await createFixtureUser("target_u", "Target User");
      const org = await createFixtureOrg("test_d", "Test D Org");

      await db.membership.create({
        data: { userId: memberUser.id, orgId: org.id, role: Role.MEMBER },
      });
      await db.membership.create({
        data: { userId: managerUser.id, orgId: org.id, role: Role.MANAGER },
      });
      const targetMem = await db.membership.create({
        data: { userId: targetUser.id, orgId: org.id, role: Role.MEMBER },
      });

      // Member attempts role update
      (auth as jest.Mock).mockResolvedValue({ user: { id: memberUser.id } });
      const memUpdateRes = await updateMemberRole(org.slug, targetMem.id, Role.ADMIN);
      expect(memUpdateRes.success).toBe(false);
      expect(memUpdateRes.error).toContain("Forbidden");

      // Manager attempts member removal
      (auth as jest.Mock).mockResolvedValue({ user: { id: managerUser.id } });
      const mgrRemoveRes = await removeMember(org.slug, targetMem.id);
      expect(mgrRemoveRes.success).toBe(false);
      expect(mgrRemoveRes.error).toContain("Forbidden");

      // Verify target membership is completely untouched
      const freshTarget = await db.membership.findUnique({
        where: { id: targetMem.id },
      });
      expect(freshTarget?.role).toBe(Role.MEMBER);
    });

    // TEST E: Cross-tenant target mutation rejection
    it("Test E: rejects cross-tenant member mutation without leaking data", async () => {
      const adminA = await createFixtureUser("admin_org_a", "Admin Org A");
      const orgA = await createFixtureOrg("org_a", "Org A");
      const orgB = await createFixtureOrg("org_b", "Org B");

      await db.membership.create({
        data: { userId: adminA.id, orgId: orgA.id, role: Role.ADMIN },
      });

      const memberInB = await createFixtureUser("user_in_b", "User In B");
      const memInB = await db.membership.create({
        data: { userId: memberInB.id, orgId: orgB.id, role: Role.MEMBER },
      });

      // Admin from Org A tries to mutate membership from Org B
      (auth as jest.Mock).mockResolvedValue({ user: { id: adminA.id } });
      const crossRes = await updateMemberRole(orgA.slug, memInB.id, Role.ADMIN);

      expect(crossRes.success).toBe(false);
      expect(crossRes.error).toContain("Member not found in this organization");

      // Verify Org B membership was NOT modified
      const untouchedInB = await db.membership.findUnique({
        where: { id: memInB.id },
      });
      expect(untouchedInB?.role).toBe(Role.MEMBER);
    });
  });
});
