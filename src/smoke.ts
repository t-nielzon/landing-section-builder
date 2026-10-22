import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { closeBrowser } from "./browser.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { renderPreview } from "./render.ts";
import { extractSource } from "./source.ts";
import { ensureProduct, uploadImages } from "./store.ts";
import { SECTION_FILE, SECTION_KEY, TEMPLATE_FILE } from "./tools.ts";
import { pushFiles, themeCheck, writeLocal } from "./theme.ts";
import { checkSection, checkTemplate } from "./validate.ts";

// exercises every tool against the real store without the model, so plumbing bugs cost nothing
const url = process.argv[2] || "https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis";
const dir = path.resolve("runs", "smoke", "theme");
await mkdir(dir, { recursive: true });
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
  log.ok(msg);
};

log.title("Smoke test: tools without the model");
const source = await extractSource(url);
assert(source.sections.length === 3, `extracted 3 sections (${source.sections.map((s) => s.type).join(", ")})`);
await mkdir("runs/smoke/source", { recursive: true });
for (const s of source.screenshots) await writeFile(`runs/smoke/source/section-${s.section}-${s.part}.png`, s.png);

const urls = [...new Set(source.sections[0].nodes.flatMap((n) => (n.t === "img" ? [n.src] : [])))].slice(0, 2);
const first = await uploadImages(urls);
assert(first.every((r) => r.ref), "uploaded 2 images");
const second = await uploadImages(urls);
assert(second.every((r) => r.reused), "second upload reused existing files");

const p1 = await ensureProduct("Smoke test product", "39.90");
const p2 = await ensureProduct("Smoke test product", "39.90");
assert(p1.id === p2.id, "product upsert is idempotent");

const liquid = await readFile("test/fixtures/section.liquid", "utf8");
const check = checkSection(liquid);
assert(check.ok, "fixture section passes local checks");
await writeLocal(dir, SECTION_FILE, liquid);
const template = {
  sections: {
    [SECTION_KEY]: {
      type: config.sectionName,
      settings: { heading: "Smoke test heading" },
      blocks: Object.fromEntries(first.map((r, i) => [`slide_${i}`, { type: "slide", settings: { image: r.ref, alt: "slide" } }])),
      block_order: first.map((_, i) => `slide_${i}`),
    },
  },
  order: [SECTION_KEY],
};
assert(checkTemplate(template, check.schema!, config.sectionName).ok, "fixture template passes local checks");
await writeLocal(dir, TEMPLATE_FILE, JSON.stringify(template, null, 2));
const offenses = (await themeCheck(dir)).filter((o) => o.severity === "error");
assert(offenses.length === 0, "theme check reports no errors");
const errors = { ...(await pushFiles(dir, [SECTION_FILE])), ...(await pushFiles(dir, [TEMPLATE_FILE])) };
assert(Object.keys(errors).length === 0, "section and template pushed");

const render = await renderPreview(p1.url, SECTION_KEY);
assert(render.found, `section renders on ${p1.url}`);
assert(render.liquidErrors.length === 0 && render.brokenImages === 0, "no liquid errors or broken images");
for (const [i, png] of render.screenshots.entries()) await writeFile(`runs/smoke/render-${i + 1}.png`, png);
await closeBrowser();
log.title("Smoke test passed. Run `npm run reset` to clean up.");
