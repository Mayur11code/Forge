import { test, expect } from "@playwright/test";
import path from "path";

const SCREENSHOT_DIR = "C:/Users/Mayur/.gemini/antigravity-cli/brain/38cff073-959a-4785-8754-8c5ea4041f4d/screenshots";

test("Landing Page: Zero-overhead mouse tracking, Geist font, and Interactive DAG engine", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/");
  await page.waitForLoadState("networkidle");

  // 1. Verify Typography (Geist)
  const bodyFont = await page.evaluate(() => {
    return window.getComputedStyle(document.body).fontFamily;
  });
  console.log("Body computed font family:", bodyFont);
  expect(bodyFont.toLowerCase()).toContain("geist");

  // 2. Capture Hero Screenshot
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "landing_01_hero.png"), fullPage: false });

  // 3. Move mouse across screen and verify smooth spotlight updates without error
  await page.mouse.move(200, 200);
  await page.mouse.move(500, 400);
  await page.mouse.move(800, 300);
  await page.waitForTimeout(300);

  // 4. Scroll to Section 3: Interactive DAG Showcase
  const showcase = page.locator("text=Interactive DAG Simulation Engine");
  await showcase.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);

  // Screenshot 2: DAG Idle Baseline
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "landing_02_interactive_dag_idle.png"), fullPage: false });

  // 5. Test "Simulate DAG" forward execution
  const simulateBtn = page.locator("button:has-text('Simulate DAG')");
  await expect(simulateBtn).toBeVisible();
  await simulateBtn.click();

  // Wait for step 1 to start executing
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "landing_03_interactive_dag_simulating.png"), fullPage: false });

  // Wait for forward simulation to complete (~3.5s total)
  await page.waitForFunction(() => {
    return document.body.innerText.includes("DAG execution completed successfully");
  }, { timeout: 10000 });

  // Screenshot 4: Completed forward simulation
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "landing_04_interactive_dag_completed.png"), fullPage: false });

  // 6. Test "Simulate Saga Rollback"
  const rollbackBtn = page.locator("button:has-text('Simulate Saga Rollback')");
  await rollbackBtn.click();

  // Wait for rollback to finish
  await page.waitForFunction(() => {
    return document.body.innerText.includes("Distributed state cleanly rolled back");
  }, { timeout: 12000 });

  // Screenshot 5: Saga rollback completed
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "landing_05_interactive_dag_rollback.png"), fullPage: false });

  // 7. Click on a node to verify inspector
  const actionNode = page.locator("text=Stripe Atomic Hold").first();
  await actionNode.click();
  await page.waitForTimeout(300);
  await expect(page.locator("text=NODE INSPECTOR")).toBeVisible();
  await expect(page.locator("text=payment.authorize").first()).toBeVisible();
});
