// Connector branding: the identity this MCP server presents to hosts.
//
// Host support for connector icons is uneven and evolving (see
// docs/MCP_ICON_RESEARCH.md), so the branding rides every surface a host
// could read, cheapest first:
//
// - Unauthenticated icon bytes (GET /favicon.png, /favicon.ico,
//   /apple-touch-icon.png): the pre-auth surfaces a connector card can
//   reach. Claude derives custom-connector icons from the registrable
//   domain's /favicon.ico; other origin-scraping clients read <link
//   rel=icon> on / or fetch /favicon.ico by convention.
// - OAuth authorization-server metadata `logo_uri` (+ the standard
//   `service_documentation`): also pre-auth. `logo_uri` on server
//   metadata is a forward-looking extension (OIDC defines it for client
//   registration, not server metadata); unknown fields are ignored by
//   strict readers, so it costs nothing.
// - `serverInfo` title/description/websiteUrl/icons (SEP-973, spec
//   2025-11-25): post-auth, read from the initialize result. Behind
//   OAuth on this transport, so a pre-auth card can never see it:
//   forward-looking, plus VS Code / Cursor / ChatGPT hosted apps read
//   it when this server is connected there.
//
// The PNG/ICO bytes live next to this file (rasterized once from
// desktop/icon.png: the Arcadia mark on its dark tile) and are read
// relative to import.meta.url, so no cwd assumption. The SVG is the
// same tile redrawn from the canonical paths, self-contained for the
// serverInfo data URI (no fetch needed).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRANDING = {
  title: "Lookout",
  description:
    "Arcadia's coding-agent harness as MCP tools: delegate work to real sessions, poll progress, steer, stop and rewind.",
  websiteUrl: "https://arcadiausercontent.com",
} as const;

/** Routes the icon bytes are served at (wired in app.ts, advertised below). */
export const FAVICON_PNG_PATH = "/favicon.png";
export const FAVICON_ICO_PATH = "/favicon.ico";
export const APPLE_TOUCH_ICON_PATH = "/apple-touch-icon.png";

// The Arcadia logomark's paths, viewBox 740 × 650, inlined from
// packages/ui/src/icons/arcadia-paths.ts (branding.test.ts fails on
// drift). Inlined rather than imported so the MCP server (a separate
// process with its own jsconfig-free bun entry) stays decoupled from
// the UI kit.
const MARK_PATHS = [
  "M268.37 225.16C291.8 169.75 303.68 110.85 303.68 50.08V0H224.3V50.08C224.3 100.16 214.54 148.66 195.26 194.22C176.61 238.32 149.88 277.95 115.8 312.02C82.25 345.57 43.3 372.02 0 390.62L20.02 425.3L39.92 459.77C89.08 437.42 133.44 406.65 171.95 368.16C213.28 326.82 245.74 278.71 268.39 225.15L268.37 225.16Z",
  "M623.85 312.11C589.78 278.04 563.04 238.4 544.4 194.31C525.12 148.74 515.35 100.24 515.35 50.17V0.0100098H435.97V50.17C435.97 110.94 447.85 169.84 471.29 225.23C493.94 278.79 526.38 326.9 567.73 368.25C606.2 406.72 650.56 437.5 699.72 459.84L719.62 425.36L739.64 390.7C696.35 372.1 657.43 345.66 623.86 312.11H623.85Z",
  "M330.09 499.86L336.21 419.82C292.47 422.58 249.01 430.74 206.92 444.32C286.99 372.56 345.08 276.74 369.82 168.24C394.56 276.74 452.65 372.56 532.72 444.32C490.63 430.74 447.17 422.58 403.43 419.82L409.55 499.86C454.05 503.41 497.45 513.96 539.12 531.06C571.36 544.13 601.69 560.76 629.85 580.78L589.93 649.92C565.07 631.46 538.09 616.3 509.28 604.62C464.91 586.63 418.01 577.5 369.82 577.5C321.63 577.5 274.73 586.63 230.36 604.62C201.55 616.3 174.57 631.46 149.71 649.92L109.79 580.78C137.95 560.76 168.28 544.13 200.52 531.06C242.19 513.96 285.59 503.41 330.09 499.86Z",
] as const;

/** The mark on its dark tile, 128 grid: the serverInfo data-URI source. */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262626"/><stop offset="1" stop-color="#141414"/></linearGradient></defs>` +
  `<rect width="128" height="128" rx="28" fill="url(#g)"/>` +
  `<svg x="27" y="31" width="74" height="65" viewBox="0 0 740 650" fill="#f0f0f0">` +
  MARK_PATHS.map(d => `<path d="${d}"/>`).join("") +
  `</svg></svg>`;

/** `serverInfo.icons[].src` fallback: the icon as a self-contained data URI. */
export function iconSvgDataUri(): string {
  return `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`;
}

const here = dirname(fileURLToPath(import.meta.url));
let png: Uint8Array<ArrayBuffer> | null = null;
let ico: Uint8Array<ArrayBuffer> | null = null;

/** Normalized once: readFileSync's pooled Buffer as an exact-length view. */
function asset(name: string): Uint8Array<ArrayBuffer> {
  const b = readFileSync(join(here, name));
  // Pool buffers are never shared; the cast sheds the SharedArrayBuffer union arm.
  const exact = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  return new Uint8Array(exact);
}

/** The 180×180 PNG served at /favicon.png (memoized for the process). */
export function iconPng(): Uint8Array<ArrayBuffer> {
  png ??= asset("icon-180.png");
  return png;
}

/** The multi-size (16/32/48) ICO served at /favicon.ico. */
export function faviconIco(): Uint8Array<ArrayBuffer> {
  ico ??= asset("favicon.ico");
  return ico;
}

export interface ServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

/**
 * `serverInfo.icons`: the same-origin HTTPS PNG first (image/png is
 * MUST-support per spec), the self-contained SVG data URI second (no
 * fetch, but SHOULD-support). Structurally the SDK's Icon.
 */
export function serverIcons(publicUrl: string): ServerIcon[] {
  const base = publicUrl.replace(/\/$/, "");
  return [
    { src: `${base}${FAVICON_PNG_PATH}`, mimeType: "image/png", sizes: ["180x180"] },
    { src: iconSvgDataUri(), mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

/** `/`: a human-readable stub whose head carries every icon hint scrapers read. */
export function landingPage(publicUrl: string): string {
  const base = publicUrl.replace(/\/$/, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lookout MCP</title>
<link rel="icon" type="image/png" href="${FAVICON_PNG_PATH}">
<link rel="shortcut icon" href="${FAVICON_ICO_PATH}">
<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">
<meta property="og:title" content="Lookout MCP">
<meta property="og:image" content="${base}${FAVICON_PNG_PATH}">
<meta name="description" content="${BRANDING.description}">
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#111}
a{color:#ffd88a}code{color:#ffd88a}</style></head>
<body><h1>Lookout MCP</h1>
<p>${BRANDING.description}</p>
<p>Connector endpoint: <code>${base}/mcp</code> (OAuth 2.1). From Grok: Connectors → New Connector → Custom → paste that URL.</p>
<p><a href="${BRANDING.websiteUrl}">Lookout</a> by Arcadia.</p></body></html>`;
}
