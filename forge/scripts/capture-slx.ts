import { chromium } from "playwright";
import * as path from "path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  
  console.log("Navigating to https://slxmanagement.com/fr...");
  await page.goto("https://slxmanagement.com/fr", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  
  const outDir = path.resolve(__dirname, "../../../scratch");
  await page.screenshot({ path: path.join(outDir, "slx_01_hero.png") });
  console.log("Captured hero");

  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "slx_02_scroll_800.png") });

  await page.evaluate(() => window.scrollBy(0, 1400));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "slx_03_scroll_2200.png") });

  await browser.close();
  console.log("Done");
}

main().catch(console.error);
