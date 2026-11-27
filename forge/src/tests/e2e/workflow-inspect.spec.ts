import "dotenv/config";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import path from "path";

const RUN_ID = `rev_${Date.now().toString(36)}`;
const PASSWORD = "Password123!@#";
const SCREENSHOT_DIR = "C:/Users/Mayur/.gemini/antigravity-cli/brain/38cff073-959a-4785-8754-8c5ea4041f4d/screenshots";

const connectionString = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

let orgIdToCleanup = "";
let userIdToCleanup = "";

test.afterAll(async () => {
  if (orgIdToCleanup) {
    await prisma.workflow.deleteMany({ where: { orgId: orgIdToCleanup } });
    await prisma.membership.deleteMany({ where: { orgId: orgIdToCleanup } });
    await prisma.organization.deleteMany({ where: { id: orgIdToCleanup } });
  }
  if (userIdToCleanup) {
    await prisma.user.deleteMany({ where: { id: userIdToCleanup } });
  }
  await prisma.$disconnect();
  await pool.end();
});

test("Forge M3.1: Global shell dock, 2-row header, contextual toolbar, simulation panel, and responsive viewports", async ({ page }) => {
  // 1. Sign up & Onboard
  const email = `rev_${RUN_ID}@example.com`;
  await page.goto("/signup");
  await page.fill('input[type="text"]', "Revamp Tester");
  await page.fill('input[type="email"]', email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await page.click('button[type="submit"]');

  await page.waitForURL((url) => url.pathname.includes("/onboarding") || url.pathname.includes("/org"), {
    timeout: 30000,
  });

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) userIdToCleanup = user.id;

  if (page.url().includes("/onboarding")) {
    await page.fill('input#org-name, input[type="text"]', `Revamp Org ${RUN_ID}`);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname.includes("/org/"), { timeout: 30000 });
  }

  const org = await prisma.organization.findFirst({
    where: { name: { contains: RUN_ID } },
  });
  if (org) orgIdToCleanup = org.id;
  const orgSlug = org?.slug;

  // Set standard desktop viewport 1440x900
  await page.setViewportSize({ width: 1440, height: 900 });

  // 2. Navigate to /org/[orgId]/workflows/new
  await page.goto(`/org/${orgSlug}/workflows/new`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  // Screenshot 1: Desktop Shell with Detached Dock and Full-Bleed Canvas
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_01_desktop_1440x900.png"), fullPage: true });

  // 3. Drag "Add Trigger" onto canvas
  const triggerDragItem = page.locator('text="Add Trigger"').first();
  const canvas = page.locator('.react-flow__pane').first();

  const triggerBox = await triggerDragItem.boundingBox();
  const canvasBox = await canvas.boundingBox();

  if (triggerBox && canvasBox) {
    await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
  }

  // 4. Configure trigger in Right Inspector
  const eventSelect = page.locator('select[aria-label="Trigger Event Type"]');
  if (await eventSelect.count() > 0) {
    await eventSelect.selectOption({ index: 1 });
    await page.waitForTimeout(500);
  }

  // 5. Save the workflow to create persisted workflow record
  const saveBtn = page.locator('button:has-text("Save Workflow")');
  await saveBtn.click();
  await page.waitForURL((url) => url.pathname.includes("/workflows/") && !url.pathname.endsWith("/new"), {
    timeout: 30000,
  });
  await page.waitForTimeout(1000);

  // 6. Test the Simulation Right Panel on valid saved draft
  const simulateBtn = page.locator('button:has-text("Simulate")');
  await expect(simulateBtn).toBeVisible();
  await simulateBtn.click();
  await page.waitForTimeout(800);

  // Inspector should be replaced by the Simulation Console
  await expect(page.locator('text=[ SIMULATOR ]')).toBeVisible();

  // Execute Sandbox Run
  const executeRunBtn = page.locator('button:has-text("Execute Sandbox Run")');
  await executeRunBtn.click();
  await page.waitForTimeout(1500);

  // Results should be visible
  await expect(page.locator('text=[ SIMULATION RESULTS ]')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_03_simulation_panel.png"), fullPage: true });

  // Close simulation panel
  const closeSimBtn = page.locator('button[aria-label="Close simulation console"]');
  await closeSimBtn.click();
  await page.waitForTimeout(500);

  // 7. Drag "Add Action" onto canvas and configure its Task Title in real time
  const actionDragItem = page.locator('text="Add Action"').first();
  const actionBox = await actionDragItem.boundingBox();
  if (actionBox && canvasBox) {
    await page.mouse.move(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 200, canvasBox.y + canvasBox.height / 2 + 150, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
  }

  // Select "task.create" action type if prompted
  const actionTypeSelect = page.locator('select[aria-label="Action Type"]');
  if (await actionTypeSelect.count() > 0) {
    await actionTypeSelect.selectOption("task.create");
    await page.waitForTimeout(500);
  }

  // Type Task Title and confirm real-time update
  const taskTitleInput = page.locator('input[aria-label="Task Title"]');
  if (await taskTitleInput.count() > 0) {
    await taskTitleInput.fill("Automated CI/CD Pipeline Run");
    await page.waitForTimeout(500);
    // Verify that title is not listed in missing variables
    const missingData = page.locator('text="Missing Upstream Data"');
    if (await missingData.count() > 0) {
      const missingText = await page.locator('.bg-rose-950\\/40').allInnerTexts();
      expect(missingText.join(" ")).not.toContain("title");
    }
  }

  // Screenshot 2: Contextual Inspector open on right with configured node
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_02_node_inspector.png"), fullPage: true });

  // 8. Responsive Viewport Verifications
  // 1280 × 800
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_04_viewport_1280x800.png"), fullPage: true });

  // 1024 × 768
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_05_viewport_1024x768.png"), fullPage: true });

  // 768 × 1024 (Tablet portrait)
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_06_viewport_768x1024.png"), fullPage: true });

  // 390 × 844 (Mobile phone)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_07_viewport_390x844.png"), fullPage: true });

  // 8. Visit Automations list page (restore desktop size)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/org/${orgSlug}/workflows`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_08_automations_list.png"), fullPage: true });

  // 9. Visit Dashboard page
  await page.goto(`/org/${orgSlug}/dashboard`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "revamp_09_dashboard.png"), fullPage: true });
});
