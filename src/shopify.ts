import { config } from "./config.ts";

let cached: { token: string; expiresAt: number } | undefined;

// dev dashboard apps get short-lived tokens via the client credentials grant, so
// fetch lazily and refresh a minute early instead of storing a long-lived token
async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(`https://${config.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.shopifyClientId,
      client_secret: config.shopifyClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`shopify token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken() },
      body: JSON.stringify({ query, variables }),
    });
    // throttling is normal on bursts of file uploads; back off rather than fail the run
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) throw new Error(`shopify graphql error: ${JSON.stringify(json.errors)}`);
    return json.data as T;
  }
}
