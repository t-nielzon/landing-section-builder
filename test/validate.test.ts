import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSection, checkTemplate } from "../src/validate.ts";

const schema = {
  name: "Landing",
  settings: [
    { type: "text", id: "heading", label: "Heading" },
    { type: "image_picker", id: "hero_image", label: "Image" },
    { type: "richtext", id: "body", label: "Body" },
  ],
  blocks: [{ type: "slide", name: "Slide", settings: [{ type: "image_picker", id: "image", label: "Image" }] }],
  presets: [{ name: "Landing" }],
};
const section = (markup: string, s: object = schema) => `${markup}\n{% schema %}\n${JSON.stringify(s)}\n{% endschema %}`;
const good = section(`
<div class="landing">
  <h2>{{ section.settings.heading | escape }}</h2>
  {{ section.settings.hero_image | image_url: width: 800 | image_tag: alt: section.settings.heading }}
  {% for block in section.blocks %}<div {{ block.shopify_attributes }}>{{ block.settings.image | image_url: width: 600 | image_tag }}</div>{% endfor %}
  <span aria-hidden="true">&times;</span>
</div>
<style>.landing h2 { content: "x"; font-size: 24px; }</style>
<script>console.log("ready")</script>`);

test("accepts a section whose copy all comes from settings", () => {
  const r = checkSection(good);
  assert.deepEqual(r.errors, []);
});

test("rejects hardcoded visible text", () => {
  const r = checkSection(good.replace("<h2>", "<h2>Buy now "));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /hardcoded visible text.*Buy now/);
});

test("rejects hardcoded alt text and external image urls", () => {
  const r = checkSection(good.replace('<span aria-hidden="true">', '<img alt="Product shot" src="https://cdn.example.com/a.png"><span>'));
  assert.match(r.errors.join(), /hardcoded alt/);
  assert.match(r.errors.join(), /external asset URL/);
});

test("rejects invalid schema json and duplicate ids", () => {
  assert.match(checkSection(good.replace('"name":"Landing"', '"name":"Landing",')).errors.join(), /not valid JSON/);
  const dup = { ...schema, settings: [...schema.settings, { type: "text", id: "heading", label: "Again" }] };
  assert.match(checkSection(section("<div></div>", dup)).errors.join(), /duplicate setting id "heading"/);
});

test("rejects image settings that are not image pickers", () => {
  const bad = { ...schema, settings: [{ type: "url", id: "slide_image", label: "Image" }] };
  assert.match(checkSection(section("<div></div>", bad)).errors.join(), /use image_picker/);
});

const template = {
  sections: {
    landing: {
      type: "nomore-landing",
      settings: { heading: "Hello", hero_image: "shopify://shop_images/a.png", body: "<p>Copy</p>" },
      blocks: { s1: { type: "slide", settings: { image: "shopify://shop_images/b.png" } } },
      block_order: ["s1"],
    },
  },
  order: ["landing"],
};

test("accepts a template that matches the schema", () => {
  assert.deepEqual(checkTemplate(template, schema, "nomore-landing").errors, []);
});

test("rejects unknown settings, raw image urls and bad block order", () => {
  const bad = structuredClone(template);
  bad.sections.landing.settings.hero_image = "https://cdn.example.com/a.png";
  (bad.sections.landing.settings as Record<string, unknown>).subtitle = "x";
  bad.sections.landing.block_order = [];
  const errors = checkTemplate(bad, schema, "nomore-landing").errors.join();
  assert.match(errors, /must reference an uploaded file/);
  assert.match(errors, /"subtitle" is not defined/);
  assert.match(errors, /block_order/);
});
