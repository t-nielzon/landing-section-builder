# landing-section-builder

A Claude Agent SDK script that takes a Shopify product page URL and rebuilds the first three sections of that landing page as **one editable Liquid section** in your own Shopify theme. It is tuned for mobile fidelity.

```bash
npm start -- https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis
```

At the end of a run you get:

- `sections/nomore-landing.liquid`, pushed to the live theme. Every text, image, colour and repeating item in it is a theme editor setting or block.
- `templates/product.nomore-landing.json`, which holds this one section filled with the source content. All images are imported into the store's Files, so they can be swapped with the normal image picker.
- A placeholder product, published and assigned to that template.
- The storefront URL, the theme editor URL and the measured API cost, printed to the terminal.
- A copy of the generated files in `runs/<timestamp>/theme/`. `examples/try-nomore/` holds the output of one full run.

## How it works

The agent runs on `claude-opus-5-5` with every built-in Claude Code tool disabled. It can only act through a small in-process MCP server (`src/tools.ts`):

| Tool | Purpose |
|-|-|
| `extract_source` | Loads the page in headless Chromium on an iPhone 13 viewport and finds the first three template sections. Returns structured JSON (text in order with a deduplicated style table, rich text with bold runs, images, boxes, icons, animation hints) plus screenshots of each section. |
| `upload_images` | Imports the CDN images into Shopify Files (`fileCreate` with `originalSource`) and returns `shopify://shop_images/...` references. Existing files are reused. |
| `ensure_product` | Upserts a placeholder product by handle (`productSet`) and publishes it to the Online Store. |
| `write_section` / `edit_section` | Writes the section, or applies exact string edits to it. Each write passes three gates before it is live: local rules, `shopify theme check`, then Shopify's own validation on push. |
| `write_template` | Writes the JSON template, validated against the section's schema. |
| `render_preview` | Renders the product page at 390px and returns screenshots plus Liquid errors, console errors, broken images and horizontal overflow. |
| `finish` / `report_issue` | Ends the run explicitly. |

The model reads the source, writes the Liquid and the template, then compares its own render with the source screenshots and fixes differences. It gets at most three fix rounds. Everything that touches Shopify or a browser is deterministic code.

### What "editable" is enforced by

`src/validate.ts` rejects a section before it is pushed if it has:

- visible text anywhere outside Liquid output;
- hardcoded `alt`, `title` or `aria-label` text;
- external image URLs;
- image settings that are not `image_picker`;
- invalid or duplicate schema entries, or no preset.

Templates are checked against the schema: unknown setting IDs, image values that aren't uploaded files, malformed rich text, and a `block_order` that doesn't list every block. Unit tests cover these rules.

### Guardrails

- `maxBudgetUsd` (default 2) and `maxTurns` (default 40) on the query.
- A `PreToolUse` hook that denies a third identical call in a row, caps section writes at 8, and blocks any call after `finish`.
- `settingSources: []`, so no local Claude settings or memory files leak into the run.
- A rerun updates the same product, files and theme files instead of duplicating them.

### Why theme files go through the Shopify CLI

Theme file writes through the Admin API (`themeFilesUpsert` or the REST asset endpoint) need a Shopify-granted exemption for apps. So the section and template are pushed with `shopify theme push --only <file>`, which authenticates as a store staff account or with a Theme Access password. Products and files still use the Admin GraphQL API with the app's client credentials token.

## Setup

1. **Shopify dev store.** Create one from a Shopify Partners account or the Dev Dashboard.
2. **App.** In the Dev Dashboard, create an app with these scopes:
   - `read_themes`, `write_themes`
   - `read_products`, `write_products`
   - `read_files`, `write_files`
   - `read_publications`, `write_publications`

   Release a version and install it on the store. The script exchanges the client ID and secret for a 24-hour token (client credentials grant), so the app and the store must be in the same organization.
3. **Theme pushes.** Either run `npx shopify auth login` once, or set `SHOPIFY_CLI_THEME_TOKEN` to a password from the Theme Access app.
4. **Environment.** `cp .env.example .env` and fill it in. The storefront password is under Online Store, then Preferences.
5. **Install.**

   ```bash
   npm install
   npx playwright install chromium
   ```

Node 22 or later is required.

## Scripts

| Command | What it does |
|-|-|
| `npm start -- <url>` | Run the agent |
| `npm run reset` | Remove the section, template, placeholder product and imported files, for a clean rerun |
| `npm run smoke` | Exercise every tool against the store without the model (no API cost) |
| `npm test` | Validator unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Notes

- **Viewport:** the target is a 390px phone viewport. On wider screens the section stays a centred column.
- **Placeholder product:** it has a single variant. The bundle picker adds the chosen bundle's quantity of that variant to the cart, so there are no real bundle variants or prices behind it.
- **Images with text baked in:** some source images contain text drawn into the picture, such as the hero slides. They are imported as images, as the source does.
