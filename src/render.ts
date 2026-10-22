import type { Page } from "playwright";
import { phoneContext, screenshotRange, scrollThrough } from "./browser.ts";
import { config } from "./config.ts";

export interface RenderResult {
  url: string;
  found: boolean;
  height: number;
  horizontalOverflow: boolean;
  brokenImages: number;
  liquidErrors: string[];
  consoleErrors: string[];
  screenshots: Buffer[];
}

// dev stores sit behind a storefront password, so unlock once per context before rendering
async function unlock(page: Page): Promise<void> {
  await page.goto(`https://${config.shopDomain}/password`, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[type="password"]');
  if (!(await input.count()) || !config.storefrontPassword) return;
  await input.first().fill(config.storefrontPassword);
  await input.first().press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/password"), { timeout: 15_000 }).catch(() => {});
}

export async function renderPreview(url: string, sectionKey: string): Promise<RenderResult> {
  const context = await phoneContext();
  const consoleErrors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
    page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 200)));
    await unlock(page);
    // cache-bust so a just-pushed section is not served from the storefront cache
    await page.goto(`${url}${url.includes("?") ? "&" : "?"}_r=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await scrollThrough(page);
    const info = await page.evaluate((key) => {
      const section = document.querySelector<HTMLElement>(`[id^="shopify-section-template"][id$="__${key}"]`);
      const body = document.body.innerText;
      const liquidErrors = [...body.matchAll(/Liquid (syntax )?error[^\n]{0,160}/g)].map((m) => m[0]);
      if (!section) return { found: false, top: 0, height: 0, overflow: false, broken: 0, liquidErrors };
      const r = section.getBoundingClientRect();
      const broken = [...section.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0).length;
      return {
        found: true,
        top: r.top + scrollY,
        height: r.height,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        broken,
        liquidErrors,
      };
    }, sectionKey);
    if (info.found) {
      await page.evaluate((y) => window.scrollTo(0, y), info.top);
      await page.waitForTimeout(1500);
      for (let y = info.top; y < info.top + info.height; y += 500) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(600);
      }
      // let count-up and reveal animations finish before capturing
      await page.waitForTimeout(2500);
    }
    return {
      url,
      found: info.found,
      height: Math.round(info.height),
      horizontalOverflow: info.overflow,
      brokenImages: info.broken,
      liquidErrors: info.liquidErrors,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
      screenshots: info.found ? await screenshotRange(page, info.top, info.height) : [],
    };
  } finally {
    await context.close();
  }
}
