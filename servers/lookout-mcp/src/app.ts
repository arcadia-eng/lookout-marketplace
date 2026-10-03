// Hono wiring: the Streamable HTTP MCP endpoint, the OAuth 2.1 endpoints,
// and a health check. Stateless: each /mcp request gets a fresh transport,
// so no session affinity is needed behind the tunnel.
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LookoutClient } from "./client.js";
import { buildMcpServer, LOOKOUT_MCP_TOOL_NAMES, type ToolOptions } from "./tools.js";
import { authorized, bearerToken, installOAuth, OAuthStore, secretsEqual } from "./oauth.js";
import {
  APPLE_TOUCH_ICON_PATH, FAVICON_ICO_PATH, FAVICON_PNG_PATH,
  faviconIco, iconPng, landingPage,
} from "./branding.js";

export interface McpAppConfig {
  lookoutUrl: string;
  publicUrl: string;
  token: string;
  /** The accounts origin (consent pages + server-to-server grant calls). */
  originUrl: string;
  /** Bridge→origin credential (consent unavailable when ""). */
  bridgeToken: string;
  /** Which Mac this bridge reaches (consent screen + Sessions). */
  bridgeLabel: string;
  roots: string[];
  /**
   * Durable file for dynamic client registrations (survives restarts).
   * Unset: clients are process memory.
   */
  clientsFile?: string;
  fetchFn?: typeof fetch;
  /** Server-to-server origin calls (tests route at an in-process origin). */
  originFetch?: (path: string, init?: RequestInit) => Promise<Response>;
  buildServer?: (client: LookoutClient, opts: ToolOptions) => McpServer;
}

/** A tools/call for a tool outside the caller's grant scope: refused, naming the scope. */
function scopeRefused(name: string, scope: readonly string[]): string {
  return `Tool "${name}" is outside this connection's tool scope ` +
    `(${scope.length} of ${LOOKOUT_MCP_TOOL_NAMES.length} tools allowed). ` +
    `An owner can widen it in Customize → Connectors; the host's own toggles stay advisory.`;
}

export function createMcpApp(cfg: McpAppConfig): { app: Hono; oauth: OAuthStore } {
  const app = new Hono();
  // Per-grant tool scopes, cached without touching the OAuth flow: the
  // wrapper snoops the redeem + heartbeat answers for the grant's current
  // scope, so a scope change lands on the next refresh, the same 5-minute
  // bound as Revoke. Missing or malformed grant scopes deny every tool;
  // explicit null and the raw operator bearer authorize the full surface.
  const grantScopes = new Map<string, string[] | null>();
  const rawOriginFetch = cfg.originFetch
    ?? ((path: string, init?: RequestInit) => fetch(cfg.originUrl.replace(/\/$/, "") + path, init));
  const originFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await rawOriginFetch(path, init);
    if (init?.method === "POST" && res.ok) {
      const check = /^\/api\/auth\/mcp\/grants\/([^/]+)\/check$/.exec(path);
      const redeem = !check && /^\/api\/auth\/mcp\/requests\/[^/]+\/redeem$/.test(path);
      try {
        if (check || redeem) {
          const data = await res.clone().json() as { grant?: { id?: unknown; toolScope?: unknown } };
          const id = check ? check[1]!
            : typeof data.grant?.id === "string" ? data.grant.id : null;
          if (id) {
            const ts = data.grant?.id === id ? data.grant.toolScope : undefined;
            const scope = ts === null ? null
              : Array.isArray(ts) && ts.length <= 64 && ts.every(t => typeof t === "string")
                ? [...new Set(ts as string[])].filter(t => LOOKOUT_MCP_TOOL_NAMES.includes(t)) : [];
            grantScopes.set(id, scope); // unresolved or malformed scope is never an implicit grant
          }
        }
      } catch {
        if (check) grantScopes.set(check[1]!, []); /* snooping never breaks auth */
      }
    }
    return res;
  };
  const oauth = installOAuth(app, {
    publicUrl: cfg.publicUrl, token: cfg.token,
    originUrl: cfg.originUrl, bridgeToken: cfg.bridgeToken, bridgeLabel: cfg.bridgeLabel,
    clientsFile: cfg.clientsFile,
    originFetch,
  });
  const client = new LookoutClient(cfg.lookoutUrl, cfg.fetchFn);
  const build = cfg.buildServer ?? buildMcpServer;

  app.get("/health", c => c.json({ ok: true, service: "lookout-mcp" }));
  app.all("/mcp/", c => c.redirect("/mcp", 307));

  // Unauthenticated branding bytes (branding.ts): the pre-auth surfaces a
  // connector card can reach. Hits are logged one line each: these paths
  // are rare, and the log answers "does Grok fetch our icon" after the
  // owner re-adds the connector (match on Grok/xAI user agents).
  const noteBrandingHit = (c: { req: { path: string; header: (h: string) => string | undefined } }) =>
    console.log(`mcp branding: GET ${c.req.path} fwd=${c.req.header("x-forwarded-for") ?? "?"} ua=${c.req.header("user-agent") ?? "?"}`);
  const iconCache = { "cache-control": "public, max-age=86400" };
  app.get(FAVICON_PNG_PATH, c => {
    noteBrandingHit(c);
    return new Response(iconPng(), { headers: { "content-type": "image/png", ...iconCache } });
  });
  app.get(APPLE_TOUCH_ICON_PATH, c => {
    noteBrandingHit(c);
    return new Response(iconPng(), { headers: { "content-type": "image/png", ...iconCache } });
  });
  app.get(FAVICON_ICO_PATH, c => {
    noteBrandingHit(c);
    return new Response(faviconIco(), { headers: { "content-type": "image/x-icon", ...iconCache } });
  });
  app.get("/", c => c.html(landingPage(cfg.publicUrl)));

  app.all("/mcp", async c => {
    if (!authorized(c.req.raw, oauth, cfg.token)) {
      return c.json({ error: "missing or invalid bearer token" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${cfg.publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource"`,
      });
    }
    // The caller's scope: the raw operator bearer is the full surface, an
    // OAuth token carries its grant's cached scope (unknown: no tools).
    const bearer = bearerToken(c.req.raw) ?? "";
    const raw = bearer !== "" && secretsEqual(bearer, cfg.token);
    const grantId = raw ? null : oauth.access.get(bearer)?.grantId ?? null;
    const scope = raw ? null : grantId && grantScopes.has(grantId) ? grantScopes.get(grantId)! : [];
    // tools/call outside the scope never reaches the server: refused here
    // with an error naming the scope. tools/list filters itself through the
    // scoped build below.
    let body: { method?: unknown; id?: unknown; params?: { name?: unknown } } | null = null;
    try {
      const parsed: unknown = await c.req.raw.clone().json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as { method?: unknown; id?: unknown; params?: { name?: unknown } };
    } catch { /* malformed bodies are the transport's to report */ }
    if (scope && body?.method === "tools/call") {
      const name = body.params?.name;
      if (typeof name === "string" && !scope.includes(name)) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: scopeRefused(name, scope) }) }],
            isError: true,
          },
        });
      }
    }
    // Plain JSON responses: our tools are request/response (delegate returns
    // fast, progress is polled), so no SSE streaming is needed. The response
    // is materialized before handleRequest resolves, so per-request cleanup
    // in the finally below is safe.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = build(client, { roots: cfg.roots, publicUrl: cfg.publicUrl, allowedTools: scope });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  return { app, oauth };
}
