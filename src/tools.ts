import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { renderPreview } from "./render.ts";
import { extractSource, type SourceExtract } from "./source.ts";
import { editorUrl, ensureProduct, mainThemeId, uploadImages, type ProductInfo } from "./store.ts";
import { pushFiles, themeCheck, writeLocal } from "./theme.ts";
import { checkSection, checkTemplate, type SectionSchema } from "./validate.ts";

export const SECTION_FILE = `sections/${config.sectionName}.liquid`;
export const TEMPLATE_FILE = `templates/product.${config.templateSuffix}.json`;
export const SECTION_KEY = "landing";

export interface RunState {
  themeDir: string;
  source?: SourceExtract;
  product?: ProductInfo;
  sectionLiquid?: string;
  schema?: SectionSchema;
  templateWritten: boolean;
  renders: number;
  finished?: { summary: string };
  issue?: string;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text", text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const png = (buf: Buffer): Content => ({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });

// every theme write goes through the same gate: local rules, then theme check, then shopify itself
async function deploy(state: RunState, filename: string, content: string): Promise<{ ok: boolean; report: string }> {
  await writeLocal(state.themeDir, filename, content);
  const offenses = await themeCheck(state.themeDir);
  const errors = offenses.filter((o) => o.severity === "error");
  const warnings = offenses.filter((o) => o.severity !== "error").slice(0, 8);
  const fmt = (o: (typeof offenses)[number]) => `${o.file}:${o.line} ${o.check}: ${o.message}`;
  if (errors.length) return { ok: false, report: `theme check errors (not pushed):\n${errors.map(fmt).join("\n")}` };
  const pushErrors = await pushFiles(state.themeDir, [filename]);
  const fileErrors = Object.entries(pushErrors).flatMap(([f, errs]) => errs.map((e) => `${f}: ${e}`));
  if (fileErrors.length) return { ok: false, report: `shopify rejected the file:\n${fileErrors.join("\n")}` };
  return { ok: true, report: `pushed ${filename}${warnings.length ? `\ntheme check warnings:\n${warnings.map(fmt).join("\n")}` : ""}` };
}

async function deploySection(state: RunState, liquid: string) {
  const check = checkSection(liquid);
  if (!check.ok) {
    log.warn("section rejected by local checks", check.errors.length);
    return fail(`section not pushed, fix these first:\n- ${check.errors.join("\n- ")}`);
  }
  const { ok, report } = await deploy(state, SECTION_FILE, liquid);
  if (!ok) {
    log.warn("section rejected", report.split("\n")[0]);
    return fail(report);
  }
  state.sectionLiquid = liquid;
  state.schema = check.schema;
  log.ok(`section live (${liquid.length} chars, ${check.schema?.settings?.length ?? 0} settings, ${check.schema?.blocks?.length ?? 0} block types)`);
  // the template validates against the schema, so a schema change can strand stale values
  return text(`${report}${state.templateWritten ? "\nnote: if you renamed settings or blocks, rewrite the template to match." : ""}`);
}

export function buildServer(state: RunState) {
  return createSdkMcpServer({
    name: "shop",
    version: "1.0.0",
    tools: [
      tool(
        "extract_source",
        "Load the source product page on a 390px phone viewport and return its first three content sections as structured JSON (text in order with style ids, images, boxes, icons, animations) plus screenshots of each section. Call once at the start.",
        { url: z.url() },
        async ({ url }) => {
          log.step(`extracting first 3 sections of ${url}`);
          const source = await extractSource(url);
          state.source = source;
          const { screenshots, ...data } = source;
          const images = [...new Set(source.sections.flatMap((s) => s.nodes.flatMap((n) => (n.t === "img" ? [n.src] : []))))];
          log.ok(`found ${source.sections.map((s) => `${s.type} (${s.height}px)`).join(", ")}; ${images.length} images`);
          return {
            content: [
              { type: "text", text: JSON.stringify({ ...data, imageUrls: images }) },
              ...screenshots.flatMap((s): Content[] => [
                { type: "text", text: `source screenshot: section ${s.section} (${source.sections[s.section - 1].type}), part ${s.part}` },
                png(s.png),
              ]),
            ],
          };
        },
      ),
      tool(
        "upload_images",
        "Import images into the store's Files from their source CDN URLs. Returns a shopify://shop_images/... reference per URL for use as image_picker values in the template. Safe to call again; existing files are reused.",
        { urls: z.array(z.url()).min(1).max(60) },
        async ({ urls }) => {
          log.step(`importing ${urls.length} images into Shopify Files`);
          const results = await uploadImages(urls);
          const failed = results.filter((r) => r.error);
          log.ok(`${results.length - failed.length} ready${failed.length ? `, ${failed.length} failed` : ""}`);
          return text(results.map((r) => `${r.source} -> ${r.ref ?? `ERROR ${r.error}`}`).join("\n"));
        },
      ),
      tool(
        "ensure_product",
        "Create or update the placeholder product the landing page renders on. It uses the landing template and is published to the online store. Use the source product title and the first bundle's price.",
        { title: z.string().min(1), price: z.string().regex(/^\d+(\.\d{1,2})?$/) },
        async ({ title, price }) => {
          log.step(`ensuring placeholder product "${title}" at ${price}`);
          state.product = await ensureProduct(title, price);
          log.ok(`product ready at ${state.product.url}`);
          return text(JSON.stringify(state.product));
        },
      ),
      tool(
        "write_section",
        `Write the full Liquid section file (${SECTION_FILE}) including its {% schema %}. It is checked locally (no hardcoded copy, image_picker for images, valid schema), linted with theme check, then pushed to the live theme. Use edit_section for later fixes.`,
        { liquid: z.string().min(200) },
        async ({ liquid }) => {
          log.step("writing section");
          return deploySection(state, liquid);
        },
      ),
      tool(
        "edit_section",
        "Apply targeted string replacements to the current section file and push it again. Each find string must match exactly once. Cheaper than rewriting the whole file.",
        { edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1).max(20) },
        async ({ edits }) => {
          if (!state.sectionLiquid) return fail("no section written yet; call write_section first");
          let liquid = state.sectionLiquid;
          for (const [i, { find, replace }] of edits.entries()) {
            const count = liquid.split(find).length - 1;
            if (count !== 1) return fail(`edit ${i + 1}: find string matched ${count} times, it must match exactly once; no edits applied`);
            liquid = liquid.replace(find, () => replace);
          }
          log.step(`editing section (${edits.length} change${edits.length > 1 ? "s" : ""})`);
          return deploySection(state, liquid);
        },
      ),
      tool(
        "write_template",
        `Write ${TEMPLATE_FILE}: a JSON template with exactly one section keyed "${SECTION_KEY}" of type "${config.sectionName}", holding every setting and block value copied from the source. Image settings must use the references from upload_images.`,
        { template_json: z.string().min(20) },
        async ({ template_json }) => {
          if (!state.schema) return fail("write the section first; the template is validated against its schema");
          let template: any;
          try {
            template = JSON.parse(template_json);
          } catch (e) {
            return fail(`template is not valid JSON: ${(e as Error).message}`);
          }
          const check = checkTemplate(template, state.schema, config.sectionName);
          if (!check.ok) return fail(`template not pushed, fix these first:\n- ${check.errors.join("\n- ")}`);
          if (Object.keys(template.sections)[0] !== SECTION_KEY) return fail(`the section key must be "${SECTION_KEY}"`);
          log.step("writing template");
          const { ok, report } = await deploy(state, TEMPLATE_FILE, JSON.stringify(template, null, 2));
          if (!ok) return fail(report);
          state.templateWritten = true;
          const blocks = Object.keys(template.sections[SECTION_KEY].blocks ?? {}).length;
          log.ok(`template live with ${blocks} blocks`);
          return text(report);
        },
      ),
      tool(
        "render_preview",
        "Render the placeholder product page on a 390px phone viewport and return screenshots of the section plus checks: Liquid errors, console errors, broken images and horizontal overflow. Compare against the source screenshots.",
        {},
        async () => {
          if (!state.product || !state.templateWritten) return fail("create the product and write the template before rendering");
          state.renders++;
          log.step(`rendering on a phone viewport (round ${state.renders})`);
          const r = await renderPreview(state.product.url, SECTION_KEY);
          if (!r.found) return fail(`section not found on ${r.url}. liquid errors: ${r.liquidErrors.join("; ") || "none"}`);
          const issues = [
            ...r.liquidErrors.map((e) => `liquid: ${e}`),
            ...r.consoleErrors.map((e) => `console: ${e}`),
            ...(r.brokenImages ? [`${r.brokenImages} broken images`] : []),
            ...(r.horizontalOverflow ? ["page scrolls horizontally on mobile"] : []),
          ];
          log.ok(`rendered ${r.height}px, ${issues.length ? `${issues.length} issues` : "no errors"}`);
          return {
            content: [
              { type: "text", text: JSON.stringify({ url: r.url, sectionHeight: r.height, issues }) },
              ...r.screenshots.flatMap((buf, i): Content[] => [{ type: "text", text: `render part ${i + 1}` }, png(buf)]),
            ],
          };
        },
      ),
      tool(
        "finish",
        "Call when the rendered section closely matches the source and has no errors. Summarise what was built.",
        { summary: z.string().min(10) },
        async ({ summary }) => {
          if (!state.templateWritten || state.renders === 0) return fail("render and check the page before finishing");
          state.finished = { summary };
          return text("done");
        },
      ),
      tool(
        "report_issue",
        "Stop the run when the job cannot be completed (for example the source page cannot be read). Explain why.",
        { reason: z.string().min(10) },
        async ({ reason }) => {
          state.issue = reason;
          log.warn(`agent reported an issue: ${reason}`);
          return text("stopping");
        },
      ),
    ],
  });
}

export async function readPrompt(): Promise<string> {
  return readFile(path.resolve("prompts/system.md"), "utf8");
}

export async function links(state: RunState) {
  const themeId = await mainThemeId();
  return {
    storefront: state.product?.url,
    editor: state.product ? editorUrl(themeId, state.product.handle) : undefined,
  };
}
