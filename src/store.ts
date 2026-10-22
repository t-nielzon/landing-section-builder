import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { config } from "./config.ts";
import { gql } from "./shopify.ts";

// every uploaded file gets this prefix so reruns can find and reuse them, and reset can remove them
const FILE_PREFIX = "nml-";

export async function mainThemeId(): Promise<string> {
  const data = await gql(`{ themes(first: 1, roles: [MAIN]) { nodes { id name } } }`);
  const theme = data.themes.nodes[0];
  if (!theme) throw new Error("store has no published theme");
  return theme.id;
}

function fileNameFor(url: string): string {
  const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "image");
  return FILE_PREFIX + base.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

const imageRef = (filename: string) => `shopify://shop_images/${filename}`;

const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");

// shopify may convert formats on import (webp arrives as jpg), so match on the name without extension
async function existingFiles(names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < names.length; i += 20) {
    const chunk = names.slice(i, i + 20);
    const stems = new Map(chunk.map((n) => [stem(n), n]));
    const query = [...stems.keys()].map((s) => `filename:${s}*`).join(" OR ");
    const data = await gql(
      `query($q: String!) { files(first: 100, query: $q) { nodes { ... on MediaImage { fileStatus image { url } } } } }`,
      { q: query },
    );
    for (const node of data.files.nodes) {
      if (node.fileStatus !== "READY" || !node.image?.url) continue;
      const stored = decodeURIComponent(new URL(node.image.url).pathname.split("/").pop()!);
      const original = stems.get(stem(stored));
      if (original && !found.has(original)) found.set(original, stored);
    }
  }
  return found;
}

// shopify's file search is eventually consistent, so a just-imported file can be missing from
// results for a few seconds; a local ledger covers that window and reset clears it
const LEDGER = "runs/.uploads.json";
async function readLedger(): Promise<Record<string, string>> {
  try {
    const all = JSON.parse(await readFile(LEDGER, "utf8"));
    return all[config.shopDomain] ?? {};
  } catch {
    return {};
  }
}
async function saveLedger(entries: Record<string, string>): Promise<void> {
  await mkdir("runs", { recursive: true });
  let all: Record<string, Record<string, string>> = {};
  try {
    all = JSON.parse(await readFile(LEDGER, "utf8"));
  } catch {}
  all[config.shopDomain] = { ...(all[config.shopDomain] ?? {}), ...entries };
  await writeFile(LEDGER, JSON.stringify(all, null, 2));
}

export interface UploadResult {
  source: string;
  ref?: string;
  error?: string;
  reused?: boolean;
}

// shopify fetches each cdn url itself, so no bytes pass through this process
export async function uploadImages(urls: string[]): Promise<UploadResult[]> {
  const unique = [...new Set(urls)];
  const names = new Map(unique.map((u) => [u, fileNameFor(u)]));
  const existing = await existingFiles([...names.values()]);
  const ledger = await readLedger();
  for (const [u, name] of names) if (!existing.has(name) && ledger[u]) existing.set(name, ledger[u]);
  const results = new Map<string, UploadResult>();
  const pending: { url: string; id: string; name: string }[] = [];

  const toCreate = unique.filter((u) => !existing.has(names.get(u)!));
  for (const u of unique) {
    const stored = existing.get(names.get(u)!);
    if (stored) results.set(u, { source: u, ref: imageRef(stored), reused: true });
  }

  for (let i = 0; i < toCreate.length; i += 10) {
    const batch = toCreate.slice(i, i + 10);
    const data = await gql(
      `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message } } }`,
      { files: batch.map((u) => ({ originalSource: u, contentType: "IMAGE", filename: names.get(u) })) },
    );
    const { files, userErrors } = data.fileCreate;
    if (userErrors.length) for (const u of batch) results.set(u, { source: u, error: userErrors.map((e: any) => e.message).join("; ") });
    else batch.forEach((u, j) => pending.push({ url: u, id: files[j].id, name: names.get(u)! }));
  }

  // processing is async on shopify's side; poll until each file settles
  const deadline = Date.now() + 120_000;
  while (pending.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const data = await gql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { id ... on MediaImage { fileStatus fileErrors { message } image { url } } } }`,
      { ids: pending.map((p) => p.id) },
    );
    for (const node of data.nodes) {
      const idx = pending.findIndex((p) => p.id === node.id);
      if (idx < 0 || node.fileStatus === "UPLOADED" || node.fileStatus === "PROCESSING") continue;
      const [p] = pending.splice(idx, 1);
      if (node.fileStatus === "READY") {
        const stored = decodeURIComponent(new URL(node.image.url).pathname.split("/").pop()!);
        results.set(p.url, { source: p.url, ref: imageRef(stored) });
      } else {
        results.set(p.url, { source: p.url, error: node.fileErrors?.map((e: any) => e.message).join("; ") || node.fileStatus });
      }
    }
  }
  for (const p of pending) results.set(p.url, { source: p.url, error: "timed out waiting for shopify to process the file" });
  const created = [...results.values()].filter((r) => r.ref && !r.reused);
  await saveLedger(Object.fromEntries(created.map((r) => [r.source, r.ref!.replace("shopify://shop_images/", "")])));
  return unique.map((u) => results.get(u)!);
}

export interface ProductInfo {
  id: string;
  handle: string;
  url: string;
  variantId: string;
}

// keyed by handle, so a rerun updates the same placeholder instead of creating duplicates
export async function ensureProduct(title: string, price: string): Promise<ProductInfo> {
  const data = await gql(
    `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
      productSet(input: $input, identifier: $identifier, synchronous: true) {
        product { id handle variants(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`,
    {
      identifier: { handle: config.productHandle },
      input: {
        title,
        handle: config.productHandle,
        status: "ACTIVE",
        templateSuffix: config.templateSuffix,
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
        ],
      },
    },
  );
  const { product, userErrors } = data.productSet;
  if (userErrors.length) throw new Error(userErrors.map((e: any) => `${e.field?.join(".")}: ${e.message}`).join("; "));

  // api-created products are unpublished by default, which would 404 on the storefront
  const pubs = await gql(`{ publications(first: 20) { nodes { id name } } }`);
  const online = pubs.publications.nodes.find((p: any) => p.name === "Online Store");
  if (online) {
    const res = await gql(
      `mutation($id: ID!, $pub: ID!) { publishablePublish(id: $id, input: [{ publicationId: $pub }]) { userErrors { message } } }`,
      { id: product.id, pub: online.id },
    );
    const errs = res.publishablePublish.userErrors;
    if (errs.length) throw new Error(`publish failed: ${errs.map((e: any) => e.message).join("; ")}`);
  }
  return {
    id: product.id,
    handle: product.handle,
    url: `https://${config.shopDomain}/products/${product.handle}`,
    variantId: product.variants.nodes[0]?.id,
  };
}

export function editorUrl(themeId: string, productHandle: string): string {
  const numericId = themeId.split("/").pop();
  return `https://admin.shopify.com/store/${config.shopDomain.replace(".myshopify.com", "")}/themes/${numericId}/editor?previewPath=${encodeURIComponent(`/products/${productHandle}`)}`;
}

// returns the store to the state before a run so a recording starts from scratch
export async function resetStore(): Promise<string[]> {
  const log: string[] = [];
  const { deleteFiles } = await import("./theme.ts");
  // the template references the section, so it has to go first
  for (const filename of [`templates/product.${config.templateSuffix}.json`, `sections/${config.sectionName}.liquid`]) {
    await deleteFiles([filename]);
    log.push(`removed ${filename}`);
  }
  const product = await gql(`query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: config.productHandle });
  if (product.productByIdentifier) {
    await gql(`mutation($id: ID!) { productDelete(input: { id: $id }) { userErrors { message } } }`, { id: product.productByIdentifier.id });
    log.push(`deleted product ${config.productHandle}`);
  }
  // deletion is async on shopify's side, so cap the sweeps instead of looping until empty
  for (let sweep = 0; sweep < 5; sweep++) {
    const data = await gql(`{ files(first: 100, query: "filename:${FILE_PREFIX}*") { nodes { id } } }`);
    const ids = data.files.nodes.map((n: any) => n.id);
    if (!ids.length) break;
    await gql(`mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { message } } }`, { ids });
    log.push(`deleted ${ids.length} uploaded files`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await rm(LEDGER, { force: true });
  return log;
}
