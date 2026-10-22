function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}, copy .env.example to .env and fill it in`);
  return value;
}

export const config = {
  get shopDomain() {
    return `${required("SHOPIFY_STORE")}.myshopify.com`;
  },
  get shopifyClientId() {
    return required("SHOPIFY_CLIENT_ID");
  },
  get shopifyClientSecret() {
    return required("SHOPIFY_CLIENT_SECRET");
  },
  get shopifyApiVersion() {
    return process.env.SHOPIFY_API_VERSION || "2026-10";
  },
  get storefrontPassword() {
    return process.env.STOREFRONT_PASSWORD || "";
  },
  sectionName: "nomore-landing",
  templateSuffix: "nomore-landing",
  productHandle: "nomore-landing-demo",
};
