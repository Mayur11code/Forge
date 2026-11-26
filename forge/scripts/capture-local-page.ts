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
  await page.mouse.wheel(0, 850);
  await page.waitForTimeout(1500);
  const physicsPath = path.join(ARTIFACT_DIR, "local_03_physics_deck.png");
  await page.screenshot({ path: physicsPath });
  console.log("Saved:", physicsPath);

  // 4. Scroll to Section 3: Fluid Architectural Gallery
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1500);
  const galleryPath = path.join(ARTIFACT_DIR, "local_04_gallery_chapter.png");
  await page.screenshot({ path: galleryPath });
  console.log("Saved:", galleryPath);

  // 5. Scroll to Section 4: DAG Workflow Engine
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1500);
  const dagPath = path.join(ARTIFACT_DIR, "local_05_dag_simulator.png");
  await page.screenshot({ path: dagPath });
  console.log("Saved:", dagPath);

  await browser.close();
  console.log("Finished all captures successfully!");
}

capture().catch(console.error);
