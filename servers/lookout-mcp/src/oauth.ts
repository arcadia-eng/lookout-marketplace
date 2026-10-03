// OAuth 2.1 authorization server for the MCP endpoint, with the human step
// delegated to the Lookout account (Cursor-style). Grok runs the standard
// flow (discovery → dynamic registration → PKCE code → Bearer) while the
// browser consents on the origin: GET /authorize opens a pending consent
// request server-to-server and redirects the browser to the origin consent
// page (login inline when signed out, one-click Authorize when signed in),
// and GET /consent/callback redeems the one-time grant code and completes
// the code flow.
//
// Tokens stay bridge-minted for zero per-tool-call origin dependency, but
// every refresh revalidates the grant with the origin: revoking the grant
// (Sessions → Revoke) kills the connector within one access-token lifetime.
// The raw LOOKOUT_MCP_TOKEN bearer stays for the local Inspector and tests
// only: no human flow asks for it anymore.
//
// Lifetime split: dynamic client registrations are the one durable record
// (opt-in clientsFile, below): a post-restart reauth needs the
// registration, or the consumer must re-run DCR (which it may never do,
// leaving the connector dead). Codes, access/refresh tokens and pending
// consents stay process-only by lifetime choice: restart recovery is one
// re-consent hop on the surviving registration, and no live credential is
// ever written out.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hono } from "hono";
import { BRANDING, FAVICON_PNG_PATH } from "./branding.js";

const b64u = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64u(randomBytes(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CODE_TTL_MS = 10 * 60 * 1000;
/** Access lifetime = the revocation bound (documented in docs/MCP_SERVER.md). */
export const ACCESS_TOKEN_TTL_SEC = 300;
const TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SEC * 1000;
/** Refresh lifetime = the grant-expiry horizon the origin derives "expired" from (mcp-grants.test.ts pins it). */
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Constant-time string equality (hashes first so lengths never leak). */
export function secretsEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

interface Client { id: string; redirectUris: string[]; name: string }
interface Code { clientId: string; redirectUri: string; challenge: string; scope: string; exp: number; grantId: string }
interface Token { exp: number; grantId: string }
interface PendingConsent { clientId: string; redirectUri: string; scope: string; state: string; challenge: string; exp: number }

/** Minted registration ids: `c_` + base64url(rand(12)): the only id shape a durable file may carry. */
const CLIENT_ID_RE = /^c_[A-Za-z0-9_-]{16}$/;

export interface OAuthStoreOptions {
  /**
   * Durable store for dynamic client registrations (JSON, atomic rename,
   * own file 0600; missing parent dirs are created 0700, existing ones
   * keep their permissions). Unset: clients are process memory and a
   * restart forgets every registration.
   */
  clientsFile?: string;
}

/**
 * Strict reload of one persisted record: the file re-passes registration's
 * own rules plus the minted id shape, so a hand-edited store can't smuggle
 * in a redirect or an id the endpoint would never have issued.
 */
function persistedClient(rec: unknown): Client | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.client_id !== "string" || !CLIENT_ID_RE.test(r.client_id)) return null;
  const uris = r.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every(validRedirectUri)) return null;
  if (typeof r.client_name !== "string" || r.client_name.length > 120) return null;
  return { id: r.client_id, redirectUris: uris as string[], name: r.client_name };
}

/**
 * Atomic private write: a sibling temp file at 0600 is fsynced and renamed
 * over the target, so a crash or concurrent reader sees the old file or the
 * new one: never a torn client registry. Only the file is ours: missing
 * parent dirs are created 0700 but an existing dir keeps its permissions.
 */
function writeClientsFile(file: string, clients: Client[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body = JSON.stringify({
    version: 1,
    clients: clients.map(c => ({ client_id: c.id, redirect_uris: c.redirectUris, client_name: c.name })),
  }, null, 2) + "\n";
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already failing */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}

export class OAuthStore {
  clients = new Map<string, Client>();
  codes = new Map<string, Code>();
  access = new Map<string, Token>();
  refresh = new Map<string, { clientId: string; scope: string; exp: number; grantId: string }>();
  /** Origin consent requests awaiting the browser's return, keyed by request id. */
  pending = new Map<string, PendingConsent>();
  /**
   * Why durable registrations are refused, or null when the store is
   * healthy. Set when clientsFile exists but fails validation: the file is
   * preserved byte-for-byte (never overwritten) and register() throws until
   * an operator repairs or removes it.
   */
  registrationError: string | null = null;
  readonly #clientsFile?: string;

  constructor(opts?: OAuthStoreOptions) {
    this.#clientsFile = opts?.clientsFile;
    if (this.#clientsFile) this.#loadClients(this.#clientsFile);
  }

  /**
   * Load durable registrations under a strict contract: `{version: 1,
   * clients: [...]}` where every record re-passes registration's own rules
   * plus the minted id shape, and ids are unique. Any deviation marks the
   * store unusable rather than trusting a partial read: the file stays on
   * disk untouched, nothing is loaded, and durable registrations are
   * refused until an operator fixes or removes it. A missing file is the
   * normal first boot: empty and writable.
   */
  #loadClients(file: string): void {
    const fail = (why: string) => {
      this.registrationError = `${file}: ${why}`;
      console.error(`[mcp] durable client store unusable (${this.registrationError}): registrations refused until it is repaired or removed`);
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      return fail(`unreadable or malformed (${e instanceof Error ? e.message : e})`);
    }
    const env = parsed as { version?: unknown; clients?: unknown };
    if (!env || typeof env !== "object" || env.version !== 1 || !Array.isArray(env.clients))
      return fail("not a version-1 client registry");
    const loaded = new Map<string, Client>();
    for (const rec of env.clients) {
      const c = persistedClient(rec);
      if (!c) return fail("a client record failed validation");
      if (loaded.has(c.id)) return fail(`duplicate client_id ${c.id}`);
      loaded.set(c.id, c);
    }
    for (const [id, c] of loaded) this.clients.set(id, c);
  }

  /**
   * Register a client. With a durable store the write lands BEFORE the map
   * entry: a failed write leaves no phantom client and the caller sees the
   * failure, instead of a 201 that silently dies on the next restart. An
   * unusable store (registrationError) refuses outright: the file must be
   * repaired by hand, never overwritten blind.
   */
  register(redirectUris: string[], name = ""): Client {
    if (this.registrationError)
      throw new Error(`durable client store unusable: ${this.registrationError}`);
    const c = { id: `c_${rand(12)}`, redirectUris, name };
    if (this.#clientsFile) {
      try {
        writeClientsFile(this.#clientsFile, [...this.clients.values(), c]);
      } catch (e) {
        throw new Error(`could not persist client registration to ${this.#clientsFile}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.clients.set(c.id, c);
    return c;
  }

  savePending(id: string, p: PendingConsent): void {
    const t = Date.now();
    for (const [k, v] of this.pending)
      if (v.exp <= t) this.pending.delete(k);
    this.pending.set(id, p);
  }

  /** The pending request, live or gone (expired reads prune). Never consumes. */
  peekPending(id: string): PendingConsent | null {
    const p = this.pending.get(id);
    if (!p) return null;
    if (p.exp <= Date.now()) { this.pending.delete(id); return null; }
    return p;
  }

  dropPending(id: string): void {
    this.pending.delete(id);
  }

  mintCode(clientId: string, redirectUri: string, challenge: string, scope: string, grantId: string): string {
    const code = `code_${rand(24)}`;
    this.codes.set(code, { clientId, redirectUri, challenge, scope, exp: Date.now() + CODE_TTL_MS, grantId });
    return code;
  }

  redeemCode(code: string, clientId: string, redirectUri: string, verifier: string): Code | null {
    const c = this.codes.get(code);
    if (!c || c.exp < Date.now()) { this.codes.delete(code); return null; }
    if (c.clientId !== clientId || c.redirectUri !== redirectUri) return null;
    if (b64u(createHash("sha256").update(verifier).digest()) !== c.challenge) return null;
    this.codes.delete(code);
    return c;
  }

  mintTokens(clientId: string, scope: string, grantId: string): { accessToken: string; refreshToken: string; expiresIn: number } {
    const accessToken = `at_${rand(24)}`;
    const refreshToken = `rt_${rand(24)}`;
    this.access.set(accessToken, { exp: Date.now() + TOKEN_TTL_MS, grantId });
    this.refresh.set(refreshToken, { clientId, scope, exp: Date.now() + REFRESH_TTL_MS, grantId });
    return { accessToken, refreshToken, expiresIn: TOKEN_TTL_MS / 1000 };
  }

  /** Validate a refresh token without consuming it (the grant check runs first). */
  peekRefresh(refreshToken: string, clientId: string): { clientId: string; scope: string; grantId: string } | null {
    const r = this.refresh.get(refreshToken);
    if (!r) return null;
    if (r.exp < Date.now()) { this.refresh.delete(refreshToken); return null; }
    if (!clientId || r.clientId !== clientId) return null;
    return r;
  }

  /** Refresh rotates: the old token dies whether or not the caller keeps it. Client binding is always enforced. */
  rotateRefresh(refreshToken: string, clientId: string): { accessToken: string; refreshToken: string; expiresIn: number } | null {
    const r = this.refresh.get(refreshToken);
    this.refresh.delete(refreshToken);
    if (!r || r.exp < Date.now()) return null;
    if (!clientId || r.clientId !== clientId) return null;
    return this.mintTokens(clientId, r.scope, r.grantId);
  }

  dropRefresh(refreshToken: string): void {
    this.refresh.delete(refreshToken);
  }

  validAccess(token: string): boolean {
    const t = this.access.get(token);
    if (!t) return false;
    if (t.exp < Date.now()) { this.access.delete(token); return false; }
    return true;
  }
}

export interface OAuthConfig {
  /** Public base URL Grok reaches (the tunnel URL). Falls back to local for tests. */
  publicUrl: string;
  /** The raw Bearer fallback (local Inspector/tests): never shown to humans. */
  token: string;
  /** The accounts origin (consent pages + server-to-server calls). */
  originUrl: string;
  /** Bridge→origin credential. "" means consent is unavailable (local-dev only). */
  bridgeToken: string;
  /** Which Mac this bridge reaches (shown on the consent screen + Sessions). */
  bridgeLabel: string;
  store?: OAuthStore;
  /**
   * Durable file for dynamic client registrations (see OAuthStoreOptions).
   * Ignored when `store` is given: the store owns its own persistence.
   */
  clientsFile?: string;
  /** Server-to-server calls (tests route this at an in-process origin). */
  originFetch?: (path: string, init?: RequestInit) => Promise<Response>;
}

const errorPage = (title: string, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lookout MCP: ${esc(title)}</title>
<link rel="icon" type="image/png" href="${FAVICON_PNG_PATH}">
<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#111}
a{color:#9ecbff}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(detail)}</p>
<p>Start the connection again from the connector: it opens a fresh link each time.</p></body></html>`;

const redirectError = (uri: string, error: string, state: string | null) => {
  try {
    const u = new URL(uri);
    u.searchParams.set("error", error);
    if (state) u.searchParams.set("state", state);
    return Response.redirect(u.toString(), 302);
  } catch {
    return new Response("invalid redirect_uri", { status: 400 });
  }
};

/** Registration-time redirect rule: https anywhere, http only loopback, never a fragment. */
export function validRedirectUri(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
};

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() || null : null;
}

export function installOAuth(app: Hono, cfg: OAuthConfig): OAuthStore {
  const store = cfg.store ?? new OAuthStore({ clientsFile: cfg.clientsFile });
  const base = cfg.publicUrl.replace(/\/$/, "");
  const origin = cfg.originUrl.replace(/\/$/, "");
  const callOrigin = cfg.originFetch ?? ((path: string, init?: RequestInit) => fetch(origin + path, init));
  const bridgeHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.bridgeToken}`,
  };

  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    // Pre-auth branding a connector card can read (branding.ts):
    // service_documentation is RFC 8414; logo_uri is OIDC client
    // metadata reused as a forward-looking extension (ignored if unread).
    service_documentation: BRANDING.websiteUrl,
    logo_uri: `${base}${FAVICON_PNG_PATH}`,
  };
  const resourceMeta = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  };

  app.get("/.well-known/oauth-authorization-server", c => c.json(metadata));
  app.get("/.well-known/oauth-protected-resource", c => c.json(resourceMeta));
  app.get("/.well-known/oauth-protected-resource/mcp", c => c.json(resourceMeta));

  app.post("/register", async c => {
    const body = await c.req.json().catch(() => ({}));
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(validRedirectUri) : [];
    if (!uris.length) return c.json({ error: "invalid_redirect_uri" }, 400);
    const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) : "";
    // A store whose durable file failed validation refuses rather than
    // overwriting it: registration is unavailable until an operator repairs
    // or removes the file (see OAuthStore.registrationError).
    if (store.registrationError)
      return c.json({ error: "temporarily_unavailable", error_description: "client registration is unavailable until the bridge's client store is repaired" }, 503);
    let client: Client;
    try {
      client = store.register(uris, name);
    } catch (e) {
      console.error(`[mcp] ${e instanceof Error ? e.message : e}`);
      return c.json({ error: "server_error", error_description: "client registration could not be persisted" }, 500);
    }
    return c.json({
      client_id: client.id,
      redirect_uris: client.redirectUris,
      ...(name ? { client_name: name } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    }, 201);
  });

  const authorizeParams = (url: URL) => ({
    responseType: url.searchParams.get("response_type"),
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    scope: url.searchParams.get("scope") ?? "mcp",
    state: url.searchParams.get("state"),
    challenge: url.searchParams.get("code_challenge") ?? "",
    method: url.searchParams.get("code_challenge_method") ?? "plain",
  });

  // The authorize step keeps its Grok-facing shape (params in, code out via
  // the redirect_uri) but the browser consents on the origin: open the
  // request server-to-server, stash the round-trip, redirect the browser.
  app.get("/authorize", async c => {
    const p = authorizeParams(new URL(c.req.url));
    const client = store.clients.get(p.clientId);
    if (p.responseType !== "code" || !client || !client.redirectUris.includes(p.redirectUri))
      return c.text("unknown client, redirect_uri or response_type", 400);
    if (!p.challenge || p.method !== "S256")
      return redirectError(p.redirectUri, "invalid_request", p.state);
    if (p.scope !== "mcp")
      return redirectError(p.redirectUri, "invalid_scope", p.state);
    if (!cfg.bridgeToken || !origin)
      return c.html(errorPage("Account sign-in is not configured",
        "This bridge has no origin to consent against (LOOKOUT_MCP_BRIDGE_TOKEN / LOOKOUT_MCP_ORIGIN_URL)."), 503);
    let requestId: string | null = null;
    try {
      const res = await callOrigin("/api/auth/mcp/requests", {
        method: "POST", headers: bridgeHeaders,
        body: JSON.stringify({
          bridgeLabel: cfg.bridgeLabel, clientName: client.name,
          redirectUri: p.redirectUri, callbackUrl: `${base}/consent/callback`, scope: "mcp",
        }),
      });
      if (res.ok) requestId = ((await res.json()) as { request?: unknown }).request as string ?? null;
      else console.error(`[mcp] origin consent request failed: HTTP ${res.status}`);
    } catch (e) {
      console.error(`[mcp] origin unreachable opening consent: ${e instanceof Error ? e.message : e}`);
    }
    if (!requestId || typeof requestId !== "string")
      return c.html(errorPage("The account server didn't answer",
        "Lookout could not reach the account server to start sign-in. Check the connection and retry."), 502);
    store.savePending(requestId, {
      clientId: p.clientId, redirectUri: p.redirectUri, scope: p.scope,
      state: p.state ?? "", challenge: p.challenge, exp: Date.now() + PENDING_TTL_MS,
    });
    return c.redirect(`${origin}/api/auth/mcp/requests/${requestId}`, 302);
  });

  // The browser's return hop: deny relays the OAuth error to the client,
  // approve redeems the grant code server-to-server and mints the code Grok
  // redeems. Failures keep the pending request (a refresh retries the
  // redeem) except the terminal ones, which drop it.
  app.get("/consent/callback", async c => {
    const query = new URL(c.req.url).searchParams;
    const requestId = query.get("request") ?? "";
    const pending = store.peekPending(requestId);
    if (!pending)
      return c.html(errorPage("This connection link is unknown or expired",
        "It may have been used already, or timed out after ten minutes."), 410);
    const finishError = (error: string) => {
      store.dropPending(requestId);
      return redirectError(pending.redirectUri, error, pending.state || null);
    };
    const denied = query.get("error");
    if (denied) return finishError(denied);
    const grant = query.get("grant") ?? "";
    if (!grant)
      return c.html(errorPage("This connection link is incomplete",
        "It carries neither an approval nor a denial."), 400);
    let grantId: string | null = null;
    try {
      const res = await callOrigin(`/api/auth/mcp/requests/${encodeURIComponent(requestId)}/redeem`, {
        method: "POST", headers: bridgeHeaders, body: JSON.stringify({ grant }),
      });
      if (res.ok) grantId = ((await res.json()) as { grant?: { id?: unknown } }).grant?.id as string ?? null;
      else console.error(`[mcp] origin grant redeem failed: HTTP ${res.status}`);
    } catch (e) {
      console.error(`[mcp] origin unreachable redeeming grant: ${e instanceof Error ? e.message : e}`);
    }
    if (!grantId || typeof grantId !== "string")
      return c.html(errorPage("The approval didn't complete",
        "Lookout could not confirm the approval with the account server. Refresh to retry."), 502);
    store.dropPending(requestId);
    const code = store.mintCode(pending.clientId, pending.redirectUri, pending.challenge, pending.scope, grantId);
    const u = new URL(pending.redirectUri);
    u.searchParams.set("code", code);
    if (pending.state) u.searchParams.set("state", pending.state);
    return Response.redirect(u.toString(), 302);
  });

  app.post("/token", async c => {
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const get = (k: string) => typeof form[k] === "string" ? form[k] as string : "";
    const grant = get("grant_type");
    if (grant === "authorization_code") {
      const redeemed = store.redeemCode(get("code"), get("client_id"), get("redirect_uri"), get("code_verifier"));
      if (!redeemed) return c.json({ error: "invalid_grant" }, 400);
      const t = store.mintTokens(get("client_id"), redeemed.scope, redeemed.grantId);
      return c.json({
        access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn,
        refresh_token: t.refreshToken, scope: redeemed.scope,
      });
    }
    if (grant === "refresh_token") {
      const live = store.peekRefresh(get("refresh_token"), get("client_id"));
      if (!live) return c.json({ error: "invalid_grant" }, 400);
      if (live.grantId) {
        // The revocation bound's enforcement point: a revoked grant refuses
        // the refresh, so the connector dies with its live access token (at
        // most ACCESS_TOKEN_TTL_SEC after Revoke). An unreachable origin is
        // 503 WITHOUT consuming the refresh: a blip must not burn it.
        let check: Response | null = null;
        try {
          check = await callOrigin(`/api/auth/mcp/grants/${encodeURIComponent(live.grantId)}/check`, {
            method: "POST", headers: bridgeHeaders, body: "{}",
          });
        } catch (e) {
          console.error(`[mcp] origin unreachable checking grant: ${e instanceof Error ? e.message : e}`);
        }
        if (!check) return c.json({ error: "temporarily_unavailable" }, 503);
        if (check.status === 404 || check.status === 410) {
          store.dropRefresh(get("refresh_token"));
          return c.json({ error: "invalid_grant" }, 400);
        }
        if (!check.ok) return c.json({ error: "temporarily_unavailable" }, 503);
      }
      const t = store.rotateRefresh(get("refresh_token"), get("client_id"));
      if (!t) return c.json({ error: "invalid_grant" }, 400);
      return c.json({
        access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn,
        refresh_token: t.refreshToken, scope: live.scope,
      });
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return store;
}

/** Bearer check for /mcp: minted access token or the raw operator token. */
export function authorized(req: Request, store: OAuthStore, token: string): boolean {
  const t = bearerToken(req);
  // constant-time like before: this runs on every request, remotely reachable
  return !!t && (secretsEqual(t, token) || store.validAccess(t));
}
