// local checks that run before anything reaches the theme. shopify validates schema syntax
// itself, but it happily accepts hardcoded copy, which would break the "everything editable" rule.

const SETTING_TYPES = new Set([
  "checkbox", "number", "radio", "range", "select", "text", "textarea", "article", "blog", "collection",
  "collection_list", "color", "color_background", "color_scheme", "color_scheme_group", "font_picker", "html",
  "image_picker", "inline_richtext", "link_list", "liquid", "metaobject", "metaobject_list", "page", "product",
  "product_list", "richtext", "text_alignment", "url", "video", "video_url", "header", "paragraph",
]);
const SIDEBAR_ONLY = new Set(["header", "paragraph"]);

export interface Setting {
  type: string;
  id?: string;
  label?: string;
  default?: unknown;
}
export interface BlockSchema {
  type: string;
  name: string;
  limit?: number;
  settings?: Setting[];
}
export interface SectionSchema {
  name: string;
  settings?: Setting[];
  blocks?: BlockSchema[];
  max_blocks?: number;
  presets?: unknown[];
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  schema?: SectionSchema;
}

const SCHEMA_RE = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/g;

export function parseSchema(liquid: string): { schema?: SectionSchema; error?: string } {
  const matches = [...liquid.matchAll(SCHEMA_RE)];
  if (matches.length !== 1) return { error: `expected exactly one {% schema %} block, found ${matches.length}` };
  try {
    return { schema: JSON.parse(matches[0][1]) };
  } catch (e) {
    return { error: `schema is not valid JSON: ${(e as Error).message}` };
  }
}

function checkSettings(settings: Setting[] | undefined, scope: string, errors: string[]): void {
  const ids = new Set<string>();
  for (const s of settings ?? []) {
    if (!SETTING_TYPES.has(s.type)) errors.push(`${scope}: unknown setting type "${s.type}"`);
    if (SIDEBAR_ONLY.has(s.type)) continue;
    if (!s.id) {
      errors.push(`${scope}: a "${s.type}" setting has no id`);
      continue;
    }
    if (ids.has(s.id)) errors.push(`${scope}: duplicate setting id "${s.id}"`);
    ids.add(s.id);
    if (!s.label) errors.push(`${scope}: setting "${s.id}" has no label`);
    if (/image|photo|picture|icon|avatar|logo/i.test(s.id) && ["text", "url", "textarea"].includes(s.type)) {
      errors.push(`${scope}: "${s.id}" looks like an image but is a ${s.type}; use image_picker so it is editable in the theme editor`);
    }
  }
}

// strip everything that is not rendered copy: schema, styles, scripts, comments and liquid
export function visibleMarkup(liquid: string): string {
  return liquid
    .replace(SCHEMA_RE, "")
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "")
    .replace(/{%-?\s*(style|stylesheet|javascript)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/{%-?\s*liquid[\s\S]*?-?%}/g, "")
    .replace(/{{[\s\S]*?}}/g, "")
    .replace(/{%[\s\S]*?%}/g, "");
}

export function checkSection(liquid: string): CheckResult {
  const errors: string[] = [];
  const { schema, error } = parseSchema(liquid);
  if (error || !schema) return { ok: false, errors: [error ?? "schema missing"] };

  if (!schema.name) errors.push("schema has no name");
  else if (schema.name.length > 25) errors.push("schema name must be 25 characters or fewer");
  checkSettings(schema.settings, "section", errors);
  const blockTypes = new Set<string>();
  for (const block of schema.blocks ?? []) {
    if (blockTypes.has(block.type)) errors.push(`duplicate block type "${block.type}"`);
    blockTypes.add(block.type);
    if (!block.name) errors.push(`block "${block.type}" has no name`);
    checkSettings(block.settings, `block "${block.type}"`, errors);
  }
  if ((schema.max_blocks ?? 0) > 50) errors.push("max_blocks cannot exceed 50");
  if (!schema.presets?.length) errors.push("add a preset so the section can be added from the theme editor");

  const markup = visibleMarkup(liquid);
  for (const m of markup.matchAll(/\s(alt|title|placeholder|aria-label)\s*=\s*"([^"]*)"/gi)) {
    if (/[A-Za-z]{2,}/.test(m[2])) errors.push(`hardcoded ${m[1]} text "${m[2].slice(0, 40)}"; move it into a setting`);
  }
  if (/\b(src|srcset|href|poster)\s*=\s*"(https?:)?\/\//i.test(markup) || /url\(\s*['"]?(https?:)?\/\//i.test(liquid.replace(SCHEMA_RE, ""))) {
    errors.push("hardcoded external asset URL found; images must come from image_picker settings");
  }
  const text = markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const leaks = text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (leaks.length) errors.push(`hardcoded visible text found: "${leaks.slice(0, 12).join(" ")}"; every visible string must come from a setting or block`);

  return { ok: errors.length === 0, errors, schema };
}

interface TemplateSection {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, { type: string; settings?: Record<string, unknown> }>;
  block_order?: string[];
}

export function checkTemplate(template: { sections?: Record<string, TemplateSection>; order?: string[] }, schema: SectionSchema, sectionType: string): CheckResult {
  const errors: string[] = [];
  const sections = Object.entries(template.sections ?? {});
  if (sections.length !== 1) errors.push(`template must contain exactly one section, found ${sections.length}`);
  if (JSON.stringify(template.order) !== JSON.stringify(sections.map(([k]) => k))) errors.push("template order must list the section key");
  const [, section] = sections[0] ?? [];
  if (!section) return { ok: false, errors };
  if (section.type !== sectionType) errors.push(`section type must be "${sectionType}"`);

  const checkValues = (values: Record<string, unknown> | undefined, defs: Setting[] | undefined, scope: string) => {
    const byId = new Map((defs ?? []).filter((d) => d.id).map((d) => [d.id!, d]));
    for (const [id, value] of Object.entries(values ?? {})) {
      const def = byId.get(id);
      if (!def) {
        errors.push(`${scope}: "${id}" is not defined in the schema`);
        continue;
      }
      if (def.type === "image_picker" && value !== "" && !(typeof value === "string" && value.startsWith("shopify://shop_images/"))) {
        errors.push(`${scope}: image "${id}" must reference an uploaded file (shopify://shop_images/...)`);
      }
      if (def.type === "richtext" && typeof value === "string" && value && !/^<(p|ul|ol|h[1-6])[\s>]/.test(value)) {
        errors.push(`${scope}: richtext "${id}" must start with <p>, <ul>, <ol> or a heading`);
      }
      if (def.type === "inline_richtext" && typeof value === "string" && /<(p|ul|ol|div|h[1-6])[\s>]/.test(value)) {
        errors.push(`${scope}: inline_richtext "${id}" cannot contain block tags`);
      }
    }
  };
  checkValues(section.settings, schema.settings, "section");
  const blockDefs = new Map((schema.blocks ?? []).map((b) => [b.type, b]));
  const blockIds = Object.keys(section.blocks ?? {});
  for (const [id, block] of Object.entries(section.blocks ?? {})) {
    const def = blockDefs.get(block.type);
    if (!def) errors.push(`block "${id}" has unknown type "${block.type}"`);
    else checkValues(block.settings, def.settings, `block "${id}"`);
  }
  const order = section.block_order ?? [];
  if (order.length !== blockIds.length || order.some((id) => !blockIds.includes(id))) errors.push("block_order must list every block exactly once");
  if (blockIds.length > (schema.max_blocks ?? 50)) errors.push("too many blocks for max_blocks");
  return { ok: errors.length === 0, errors, schema };
}
