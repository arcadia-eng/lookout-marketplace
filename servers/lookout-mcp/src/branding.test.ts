// Connector branding: baked bytes are valid images, and every surface (icon
// routes, landing head, OAuth metadata, initialize serverInfo) advertises
// the same identity.
import { describe, expect, test } from "bun:test";
import { createMcpApp } from "./app";
import {
  BRANDING, ICON_SVG, faviconIco, iconPng, iconSvgDataUri, landingPage, serverIcons,
} from "./branding";

const TOKEN = "operator-secret";
const BASE = "https://tunnel.example.com";

function setup() {
  const fetchFn = (async () => new Response(JSON.stringify({ error: "stub" }), { status: 404 })) as unknown as typeof fetch;
  return createMcpApp({
    lookoutUrl: "http://lookout.test", publicUrl: BASE, token: TOKEN,
    originUrl: "https://accounts.example.com", bridgeToken: "", bridgeLabel: "Test Mac",
    roots: [], fetchFn,
  });
}

describe("branding assets", () => {
  test("the SVG is the self-contained 128-grid tile carrying the mark", () => {
    expect(ICON_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"')).toBe(true);
    expect(ICON_SVG).toContain('viewBox="0 0 128 128"');
    expect(ICON_SVG.match(/<path d=/g)).toHaveLength(3);
    // cross-repo drift (the mark vs the UI kit's canonical paths) is pinned
    // Lookout-side by src/mcp-contract against this package, not here.
  });

  test("the PNG is a real 180px image, the ICO a real multi-size icon", async () => {
    const png = iconPng();
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(1024);
    const ico = faviconIco();
    expect(Array.from(ico.subarray(0, 4))).toEqual([0x00, 0x00, 0x01, 0x00]);
    expect(ico.length).toBeGreaterThan(1024);
  });

  test("the data URI round-trips to the SVG", () => {
    const uri = iconSvgDataUri();
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(uri.split(",", 2)[1]!, "base64").toString("utf8")).toBe(ICON_SVG);
  });

  test("serverIcons leads with the same-origin PNG, falls back to the data URI", () => {
    const icons = serverIcons(`${BASE}/`);
    expect(icons[0]).toEqual({ src: `${BASE}/favicon.png`, mimeType: "image/png", sizes: ["180x180"] });
    expect(icons[1]!.mimeType).toBe("image/svg+xml");
    expect(icons[1]!.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  test("the landing head carries every icon hint scrapers read", () => {
    const html = landingPage(BASE);
    expect(html).toContain('rel="icon" type="image/png" href="/favicon.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain(`<meta property="og:image" content="${BASE}/favicon.png">`);
    expect(html).toContain(`${BASE}/mcp`);
  });
});

describe("branding routes", () => {
  test("icon bytes and / serve unauthenticated with cache headers", async () => {
    const { app } = setup();
    const png = await app.request("/favicon.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toContain("max-age=");
    expect((await png.arrayBuffer()).byteLength).toBe(iconPng().length);

    const touch = await app.request("/apple-touch-icon.png");
    expect(touch.status).toBe(200);
    expect(touch.headers.get("content-type")).toBe("image/png");

    const ico = await app.request("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    expect((await ico.arrayBuffer()).byteLength).toBe(faviconIco().length);

    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain('rel="icon"');
  });

  test("OAuth metadata advertises logo_uri + service_documentation", async () => {
    const { app } = setup();
    const m = await (await app.request("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(m.logo_uri).toBe(`${BASE}/favicon.png`);
    expect(m.service_documentation).toBe(BRANDING.websiteUrl);
  });

  test("bridge error pages link the icon (consent itself now lives on the origin)", async () => {
    const { app } = setup();
    const reg = await app.request("/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://grok.com/oauth/callback"] }),
    });
    const { client_id } = await reg.json() as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code", client_id, redirect_uri: "https://grok.com/oauth/callback",
      scope: "mcp", state: "s1", code_challenge: "c".repeat(43), code_challenge_method: "S256",
    });
    // No bridge token in setup: /authorize answers 503 with the branded error page.
    const page = await app.request(`/authorize?${q}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('rel="icon"');
  });

  test("initialize serverInfo carries the full SEP-973 identity", async () => {
    const { app } = setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    const init = await res.json() as { result: Record<string, unknown> };
    expect(init.result.serverInfo).toMatchObject({
      name: "lookout",
      title: BRANDING.title,
      description: BRANDING.description,
      websiteUrl: BRANDING.websiteUrl,
    });
    const icons = (init.result.serverInfo as { icons: { src: string; mimeType?: string }[] }).icons;
    expect(icons[0]).toMatchObject({ src: `${BASE}/favicon.png`, mimeType: "image/png" });
    expect(icons[1]!.mimeType).toBe("image/svg+xml");
  });
});
