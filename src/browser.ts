import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";

// the task targets mobile fidelity, so every capture uses the same phone profile
export const PHONE = devices["iPhone 13"];
const CHUNK_HEIGHT = 1300;

let browser: Browser | undefined;

export async function phoneContext(cookies: { name: string; value: string; url: string }[] = []): Promise<BrowserContext> {
  browser ??= await chromium.launch({ headless: true });
  // device scale 2 keeps small copy legible for the model without tripling image tokens
  const context = await browser.newContext({ ...PHONE, deviceScaleFactor: 2 });
  if (cookies.length) await context.addCookies(cookies);
  // tsx keeps function names via an injected __name helper, which page.evaluate code can't see
  await context.addInitScript("globalThis.__name = (fn) => fn;");
  return context;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

// walk the whole page once so lazy images load and scroll-triggered animations settle
export async function scrollThrough(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 400) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

// tall sections are split so each image stays readable after the api downscales it.
// screenshots go through cdp directly because playwright's own call waits on document.fonts,
// which never settles on some storefronts that load fonts from third-party hosts
export async function screenshotRange(page: Page, top: number, height: number): Promise<Buffer[]> {
  // sticky headers and chat widgets would otherwise be painted over the middle of the capture
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const pos = getComputedStyle(el).position;
      if ((pos === "fixed" || pos === "sticky") && !el.closest('[id^="shopify-section-template"]')) el.style.visibility = "hidden";
    }
  });
  const cdp = await page.context().newCDPSession(page);
  const shots: Buffer[] = [];
  try {
    for (let offset = 0; offset < height; offset += CHUNK_HEIGHT) {
      const h = Math.min(CHUNK_HEIGHT, height - offset);
      if (h < 40) break;
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: top + offset, width: PHONE.viewport.width, height: h, scale: 1 },
      });
      shots.push(Buffer.from(data, "base64"));
    }
  } finally {
    await cdp.detach();
  }
  return shots;
}
