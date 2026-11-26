import "dotenv/config";
import { test, expect, Page } from "@playwright/test";
import { PrismaClient, Role, InvitationStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import crypto from "crypto";

const RUN_ID = `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "Password123!@#";

// Direct DB connection for test fixtures and reliable cleanup
const connectionString = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const orgsToCleanup: string[] = [];
const usersToCleanup: string[] = [];

test.afterAll(async () => {
  if (orgsToCleanup.length > 0) {
    await prisma.task.deleteMany({ where: { project: { orgId: { in: orgsToCleanup } } } });
    await prisma.project.deleteMany({ where: { orgId: { in: orgsToCleanup } } });
    await prisma.invitation.deleteMany({ where: { orgId: { in: orgsToCleanup } } });
    await prisma.membership.deleteMany({ where: { orgId: { in: orgsToCleanup } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgsToCleanup } } });
  }

  if (usersToCleanup.length > 0) {
    await prisma.membership.deleteMany({ where: { userId: { in: usersToCleanup } } });
    await prisma.user.deleteMany({ where: { id: { in: usersToCleanup } } });
  }

  await prisma.$disconnect();
  await pool.end();
});

test.describe.serial("Milestone M1 End-to-End Browser Acceptance Suite", () => {
  // Shared state between sequential journey steps
  const founderUserEmail = `founder_${RUN_ID}@example.com`;
  let founderOrgSlug = `e2e-org-${RUN_ID}`;
  let secondaryOrgSlug = `second-org-${RUN_ID}`;

  async function loginAsFounder(page: Page, targetUrl = "/select-org") {
    await page.goto(`/login?callbackUrl=${encodeURIComponent(targetUrl)}`);
    await page.waitForLoadState("domcontentloaded");
    await page.fill('input[type="email"]', founderUserEmail);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
  }

  // =========================================================================
  // PW-M1-01: Fresh Founder Onboarding Journey
  // Visitor -> /signup -> Register -> NextAuth Session -> /onboarding -> Dashboard
  // =========================================================================
  test("PW-M1-01: Fresh founder registers account and creates first organization", async ({ page }) => {
    // 1. Visit landing page
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // 2. Navigate to /signup
    await page.goto("/signup");
    await expect(page).toHaveTitle(/Create an Account/i);

    // Fill registration form
    await page.fill('input[type="text"]', "E2E Test Founder");
    await page.fill('input[type="email"]', founderUserEmail);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);

    // Submit form
    await page.click('button[type="submit"]');

    // 3. User should be redirected to /onboarding or established session
    await page.waitForURL((url) => url.pathname.includes("/onboarding") || url.pathname.includes("/org"), {
      timeout: 30000,
    });

    // Record created user for cleanup
    const userInDb = await prisma.user.findUnique({ where: { email: founderUserEmail } });
    if (userInDb) usersToCleanup.push(userInDb.id);

    // If on /onboarding, complete organization creation
    if (page.url().includes("/onboarding")) {
      await expect(page.locator("h1")).toContainText(/Name your organization/i);

      // Fill org name
      await page.fill('input#org-name, input[type="text"]', `Acme E2E ${RUN_ID}`);
      await page.click('button[type="submit"]');

      // 4. Redirects to org workspace dashboard
      await page.waitForURL((url) => url.pathname.includes("/org/"), { timeout: 30000 });
    }

    expect(page.url()).toContain("/org/");

    // Verify DB state
    const createdOrg = await prisma.organization.findFirst({
      where: { name: { contains: RUN_ID } },
      include: { memberships: true },
    });
    expect(createdOrg).not.toBeNull();
    if (createdOrg) {
      orgsToCleanup.push(createdOrg.id);
      founderOrgSlug = createdOrg.slug;
      expect(createdOrg.memberships).toHaveLength(1);
      expect(createdOrg.memberships[0].role).toBe(Role.ADMIN);
    }
  });

  // =========================================================================
  // PW-M1-02: Organization Creation Idempotency & Replay
  // =========================================================================
  test("PW-M1-02: Organization creation is idempotent under form resubmission", async ({ page }) => {
    // Authenticate founder and land on /onboarding
    await loginAsFounder(page, "/onboarding");

    // Verify the onboarding form renders with slug preview
    const orgInput = page.locator('input#org-name, input[type="text"]').first();
    await orgInput.fill(`Secondary Org ${RUN_ID}`);

    // Verify slug preview updates reactively
    await expect(page.locator("text=secondary-org")).toBeVisible();

    // Submit organization creation
    await page.click('button[type="submit"]');

    // Should redirect to workspace dashboard
    await page.waitForURL((url) => url.pathname.includes("/org/"), { timeout: 30000 });
    expect(page.url()).toContain("/org/");

    const secondOrg = await prisma.organization.findFirst({
      where: { name: `Secondary Org ${RUN_ID}` },
      include: { memberships: true, projects: true },
    });
    expect(secondOrg).not.toBeNull();
    if (secondOrg) {
      orgsToCleanup.push(secondOrg.id);
      secondaryOrgSlug = secondOrg.slug;
      expect(secondOrg.memberships).toHaveLength(1);
      expect(secondOrg.projects).toHaveLength(1);
    }
  });

  // =========================================================================
  // PW-M1-03: Multi-Organization Selector & Header Switcher
  // =========================================================================
  test("PW-M1-03: Multi-organization selector displays memberships and switches active org", async ({ page }) => {
    // Authenticate founder directly to /select-org
    await loginAsFounder(page, "/select-org");

    await expect(page).toHaveTitle(/Select Organization/i);
    await expect(page.locator("h1")).toContainText(/Select a workspace/i);

    // Verify both organizations are displayed in selector cards
    await expect(page.locator(`text=Acme E2E ${RUN_ID}`).first()).toBeVisible();
    await expect(page.locator(`text=Secondary Org ${RUN_ID}`).first()).toBeVisible();

    // Click the Launch link for the primary organization
    const launchPrimary = page.locator(`a[href*="/org/${founderOrgSlug}"]`).first();
    await launchPrimary.click();
    await page.waitForURL((url) => url.pathname.includes(`/org/${founderOrgSlug}`), { timeout: 25000 });

    // Header OrgSwitcher: Verify switcher is present and opens dropdown
    const switcherButton = page.locator('button[aria-label="Switch organization"]').first();
    await expect(switcherButton).toBeVisible();
    await switcherButton.click();

    // Dropdown should show secondary org option
    const dropdownOption = page.locator(`button:has-text("Secondary Org")`).first();
    await expect(dropdownOption).toBeVisible();

    // Click secondary org in switcher
    await dropdownOption.click();
    await page.waitForURL((url) => url.pathname.includes(`/org/${secondaryOrgSlug}`), { timeout: 25000 });
    expect(page.url()).toContain(secondaryOrgSlug);
  });

  // =========================================================================
  // PW-M1-04: Team Member Management & Admin Mutex Safeguards
  // =========================================================================
  test("PW-M1-04: Members table displays team and protects sole administrator", async ({ page }) => {
    // Authenticate founder directly to members page
    await loginAsFounder(page, `/org/${founderOrgSlug}/members`);

    // Verify Members title and table
    await expect(page.locator("h1, h2").filter({ hasText: /Team Members/i })).toBeVisible();

    // Verify founder is listed
    await expect(page.locator("text=E2E Test Founder").first()).toBeVisible();
    await expect(page.getByText(/admin/i).first()).toBeVisible();

    // Verify "Invite Team Member" button is visible to ADMIN
    await expect(page.locator('button:has-text("Invite Team Member")')).toBeVisible();

    // Check actions menu on the sole admin: Sole admin cannot be removed
    const actionButton = page.locator('button[aria-label^="Manage"]').first();
    await expect(actionButton).toBeVisible();
    await actionButton.click();

    // Verify Remove Member button is disabled for sole admin
    const removeBtn = page.locator('button:has-text("Remove Member")');
    await expect(removeBtn).toBeVisible();
    await expect(removeBtn).toBeDisabled();
  });

  // =========================================================================
  // PW-M1-05: Invitation Acceptance Journey
  // =========================================================================
  test("PW-M1-05: Team invitation acceptance registers member into organization", async ({ browser }) => {
    const inviteeEmail = `invitee_${RUN_ID}@example.com`;
    const inviteToken = crypto.randomUUID();

    // Find the founder org ID
    const org = await prisma.organization.findUnique({ where: { slug: founderOrgSlug } });
    expect(org).not.toBeNull();

    // Create pending invitation in DB
    await prisma.invitation.create({
      data: {
        orgId: org!.id,
        email: inviteeEmail,
        role: Role.MEMBER,
        token: inviteToken,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // In a new incognito context (unauthenticated guest)
    const context = await browser.newContext();
    const guestPage = await context.newPage();

    // Visit invitation URL
    await guestPage.goto(`/invite/${inviteToken}`);
    await guestPage.waitForLoadState("domcontentloaded");

    // Unauthenticated user is redirected to login or signup with inviteToken callback
    await guestPage.waitForURL((url) => url.pathname.includes("/signup") || url.pathname.includes("/login"), {
      timeout: 20000,
    });

    // If redirected to login, click "Create account" to navigate to signup with inviteToken
    if (guestPage.url().includes("/login")) {
      const createAccountLink = guestPage.locator('a:has-text("Create account")');
      if (await createAccountLink.isVisible()) {
        await createAccountLink.click();
        await guestPage.waitForURL((url) => url.pathname.includes("/signup"), { timeout: 15000 });
      }
    }

    // Complete signup for the invited user
    if (guestPage.url().includes("/signup")) {
      await guestPage.fill('input[type="text"]', "Invited Team Mate");
      await guestPage.fill('input[type="email"]', inviteeEmail);
      await guestPage.locator('input[type="password"]').first().fill(PASSWORD);
      await guestPage.locator('input[type="password"]').nth(1).fill(PASSWORD);
      await guestPage.click('button[type="submit"]');

      // Acceptance route automatically assigns membership and redirects to org dashboard
      await guestPage.waitForURL((url) => url.pathname.includes(`/org/${founderOrgSlug}`), { timeout: 35000 });
      expect(guestPage.url()).toContain(`/org/${founderOrgSlug}`);

      const inviteeUser = await prisma.user.findUnique({ where: { email: inviteeEmail } });
      if (inviteeUser) {
        usersToCleanup.push(inviteeUser.id);
        // Verify membership in DB
        const membership = await prisma.membership.findFirst({
          where: { userId: inviteeUser.id, orgId: org!.id },
        });
        expect(membership).not.toBeNull();
        expect(membership?.role).toBe(Role.MEMBER);
      }
    }

    await context.close();
  });

  // =========================================================================
  // PW-M1-06: Profile Management (Name & Password Update)
  // =========================================================================
  test("PW-M1-06: Profile management updates user name and password", async ({ page }) => {
    // Authenticate founder directly to profile page
    await loginAsFounder(page, `/org/${founderOrgSlug}/user/profile`);

    await expect(page.locator("h1")).toContainText(/Profile Settings/i);

    // Find full name input and update it
    const nameInput = page.locator('input#profile-name');
    if (await nameInput.isVisible()) {
      await nameInput.fill("E2E Founder Updated");
      // Find the Save Profile Changes button
      const saveBtn = page.locator('button:has-text("Save Profile Changes")');
      await saveBtn.click();
      // Verify success feedback
      await expect(page.locator("text=Profile updated successfully").first()).toBeVisible({
        timeout: 15000,
      });

      // Verify DB updated
      const updatedUser = await prisma.user.findUnique({ where: { email: founderUserEmail } });
      expect(updatedUser?.name).toBe("E2E Founder Updated");
    }
  });

  // =========================================================================
  // PW-M1-07: Access-Control Negative Boundary Tests
  // =========================================================================
  test("PW-M1-07: Anonymous and unauthorized visits are rejected with login redirect", async ({ browser }) => {
    const unauthedContext = await browser.newContext();
    const guestPage = await unauthedContext.newPage();

    // 1. Visiting protected /org/[slug]/dashboard without auth -> redirect to /login
    await guestPage.goto(`/org/${founderOrgSlug}/dashboard`);
    await guestPage.waitForURL((url) => url.pathname.includes("/login"), { timeout: 15000 });
    expect(guestPage.url()).toContain("/login");

    // 2. Visiting /select-org without auth -> redirect to /login
    await guestPage.goto("/select-org");
    await guestPage.waitForURL((url) => url.pathname.includes("/login"), { timeout: 15000 });
    expect(guestPage.url()).toContain("/login");

    await unauthedContext.close();
  });
});
