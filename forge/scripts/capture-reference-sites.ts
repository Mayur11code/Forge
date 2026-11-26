import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const ARTIFACT_DIR = path.resolve("C:/Users/Mayur/.gemini/antigravity-cli/brain/38cff073-959a-4785-8754-8c5ea4041f4d/screenshots");

if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

async function captureSite(url: string, prefix: string) {
  console.log(`\n========================================`);
  console.log(`Navigating to: ${url}`);
  console.log(`========================================`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch (e: unknown) {
    console.log(`Networkidle timed out, proceeding with current state: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Wait a bit for initial animations / canvas
  await page.waitForTimeout(3000);

  // Capture Hero / Top
  const heroPath = path.join(ARTIFACT_DIR, `${prefix}_01_hero.png`);
  await page.screenshot({ path: heroPath, fullPage: false });
  console.log(`Saved hero screenshot: ${heroPath}`);

  // Inspect page details
  const pageDetails = await page.evaluate(() => {
    const title = document.title;
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const bodyColor = window.getComputedStyle(document.body).color;
    const bodyFont = window.getComputedStyle(document.body).fontFamily;
    const canvasCount = document.querySelectorAll("canvas").length;
    const svgCount = document.querySelectorAll("svg").length;
    const videoCount = document.querySelectorAll("video").length;
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, 8)
      .map((h) => ({
        tag: h.tagName,
        text: h.textContent?.trim().replace(/\s+/g, " "),
        fontSize: window.getComputedStyle(h).fontSize,
        fontFamily: window.getComputedStyle(h).fontFamily,
      }));

    return {
      title,
      bodyBg,
      bodyColor,
      bodyFont,
      canvasCount,
      svgCount,
      videoCount,
      headings,
    };
  });
  console.log(`Page Details for ${prefix}:`, JSON.stringify(pageDetails, null, 2));

  // Scroll down step 1
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1500);
  const scroll1Path = path.join(ARTIFACT_DIR, `${prefix}_02_scroll_800.png`);
  await page.screenshot({ path: scroll1Path, fullPage: false });
  console.log(`Saved scroll 800 screenshot: ${scroll1Path}`);

  // Scroll down step 2
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1500);
  const scroll2Path = path.join(ARTIFACT_DIR, `${prefix}_03_scroll_2300.png`);
  await page.screenshot({ path: scroll2Path, fullPage: false });
  console.log(`Saved scroll 2300 screenshot: ${scroll2Path}`);

  // Scroll down step 3
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(1500);
  const scroll3Path = path.join(ARTIFACT_DIR, `${prefix}_04_scroll_4800.png`);
  await page.screenshot({ path: scroll3Path, fullPage: false });
  console.log(`Saved scroll 4800 screenshot: ${scroll3Path}`);

  await browser.close();
}

async function run() {
  await captureSite("https://gofundme.com/kind-50", "kind50");
  await captureSite("https://bizar.ro/", "bizarro");
  console.log("\nFinished capturing reference sites!");
}

run().catch((err) => {
  console.error("Error capturing sites:", err);
  process.exit(1);
});
