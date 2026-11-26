import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const ARTIFACT_DIR = path.resolve("C:/Users/Mayur/.gemini/antigravity-cli/brain/38cff073-959a-4785-8754-8c5ea4041f4d/screenshots");

async function checkKind50(browser: any) {
  console.log("=== CHECKING GOFUNDME KIND 50 ===");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  
  await page.goto("https://gofundme.com/kind-50", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Analyze DOM elements, 3D transforms, CSS, interactive triggers
  const analysis = await page.evaluate(() => {
    // Check circular wheel
    const allDivs = Array.from(document.querySelectorAll("div, section, article"));
    const transformEls = allDivs.filter(el => {
      const st = window.getComputedStyle(el);
      return st.transform !== "none" || st.perspective !== "none";
    });

    // Check cards
    const cardLike = Array.from(document.querySelectorAll("[class*='card'], [class*='Card'], [class*='story'], [class*='Story'], img, a"))
      .slice(0, 30)
      .map(el => ({
        tag: el.tagName,
        className: el.className,
        rect: el.getBoundingClientRect(),
        transform: window.getComputedStyle(el).transform,
      }));

    return {
      title: document.title,
      transformElsCount: transformEls.length,
      cardSamples: cardLike.slice(0, 10),
      bodyStyle: {
        background: window.getComputedStyle(document.body).backgroundColor,
        fontFamily: window.getComputedStyle(document.body).fontFamily,
      }
    };
  });

  console.log("Kind 50 analysis:", JSON.stringify(analysis, null, 2));

  // Screenshot hero
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "kind50_detailed_hero.png") });

  // Let's drag/mouse move to see interactivity!
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.mouse.move(900, 450, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "kind50_after_drag.png") });

  await context.close();
}

async function checkBizarro() {
  console.log("=== CHECKING BIZAR.RO ===");
  // Launch with WebGPU enabled
  const browser = await chromium.launch({
    headless: false, // In headful mode, GPU & WebGPU work natively with Windows display adapter!
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
    ]
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  
  try {
    await page.goto("https://bizar.ro/", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(4000);
    
    // Screenshot
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "bizarro_headful_hero.png") });
    console.log("Saved bizarro headful hero!");

    // Interact: click or drag in center of screen
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(850, 300, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "bizarro_headful_after_drag.png") });
    console.log("Saved bizarro headful after drag!");

    const bizarroData = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return {
        canvasFound: !!canvas,
        canvasWidth: canvas?.width,
        canvasHeight: canvas?.height,
        bodyText: document.body.innerText.slice(0, 500),
      };
    });
    console.log("Bizarro Data:", bizarroData);

  } catch (err: any) {
    console.error("Bizarro error:", err.message);
  } finally {
    await browser.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await checkKind50(browser);
  } finally {
    await browser.close();
  }

  await checkBizarro();
}

main().catch(console.error);
