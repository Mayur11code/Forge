import { chromium } from "playwright";
import * as path from "path";

const ARTIFACT_DIR = path.resolve("C:/Users/Mayur/.gemini/antigravity-cli/brain/38cff073-959a-4785-8754-8c5ea4041f4d/screenshots");

async function capture() {
  console.log("Launching Chromium to capture local page on http://localhost:3000...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(2500);

  // 1. Hero Orbital Wheel
  const heroPath = path.join(ARTIFACT_DIR, "local_01_hero_orbital.png");
  await page.screenshot({ path: heroPath });
  console.log("Saved:", heroPath);

  // 2. Drag the Orbital Wheel horizontally to prove interactive rotation
  await page.mouse.move(720, 360);
  await page.mouse.down();
  await page.mouse.move(960, 360, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  const dragPath = path.join(ARTIFACT_DIR, "local_02_orbital_dragged.png");
  await page.screenshot({ path: dragPath });
  console.log("Saved:", dragPath);

  // 3. Scroll to Section 2: Bizarro 3D Physics Deck
  await page.mouse.wheel(0, 950);
  await page.waitForTimeout(1500);
  const physicsPath = path.join(ARTIFACT_DIR, "local_03_physics_deck.png");
  await page.screenshot({ path: physicsPath });
  console.log("Saved:", physicsPath);

  // 4. Click and fling cassette tape on physics canvas
  await page.mouse.move(950, 480);
  await page.mouse.down();
  await page.mouse.move(750, 320, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const tossedPath = path.join(ARTIFACT_DIR, "local_04_physics_tossed.png");
  await page.screenshot({ path: tossedPath });
  console.log("Saved:", tossedPath);

  // 5. Scroll to Section 3: Horizontal Architecture Runway
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(1500);
  const runwayPath = path.join(ARTIFACT_DIR, "local_05_runway.png");
  await page.screenshot({ path: runwayPath });
  console.log("Saved:", runwayPath);

  await browser.close();
  console.log("Finished all captures successfully!");
}

capture().catch(console.error);
