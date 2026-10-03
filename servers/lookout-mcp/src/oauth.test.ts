// The OAuth 2.1 flow Grok runs: discovery → registration → origin consent
// → PKCE code redemption → Bearer on /mcp, against a stub origin. The
// Grok-facing shape is unchanged; the browser's consent step moved to the
// Lookout account (see src/mcp/consent.test.ts for the proof against the
// real origin).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { installOAuth, authorized, OAuthStore, bearerToken, ACCESS_TOKEN_TTL_SEC } from "./oauth";
import { createMcpApp } from "./app";

const TOKEN = "operator-secret";
const BRIDGE = "bridge-secret";
const BASE = "https://tunnel.example.com";
const ORIGIN = "https://accounts.test";

interface StubRequest { grant: string | null; status: string; grantId: string | null }

function stubOrigin() {
  const requests = new Map<string, StubRequest>();
  const grants = new Map<string, boolean>();
  const creates: Record<string, unknown>[] = [];
  const checks: string[] = [];
  let counter = 0;
  const stub = {
    requests, grants, creates, checks,
    down: false,
    approve(id: string): string {
      const r = requests.get(id)!;
      r.status = "approved";
      r.grant = `grant_${id}`;
      return r.grant;
    },
    deny(id: string): void {
      requests.get(id)!.status = "denied";
    },
    revokeGrant(id: string): void {
      grants.set(id, false);
    },
  };
  const originFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (stub.down) throw new Error("origin down");
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${BRIDGE}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === "/api/auth/mcp/requests" && init?.method === "POST") {
      creates.push(body);
      counter += 1;
      const id = `mreq_${counter}`;
      requests.set(id, { grant: null, status: "pending", grantId: null });
      return Response.json({ request: id, expiresAt: Date.now() + 600_000 }, { status: 201 });
    }
    const redeem = /^\/api\/auth\/mcp\/requests\/([^/]+)\/redeem$/.exec(path);
    if (redeem && init?.method === "POST") {
      const r = requests.get(redeem[1]!);
      if (!r) return Response.json({ error: "unknown request" }, { status: 404 });
      if (r.status === "denied") return Response.json({ error: "declined" }, { status: 403 });
      if (!r.grant || body.grant !== r.grant) return Response.json({ error: "invalid grant" }, { status: 401 });
      if (r.status !== "approved") return Response.json({ error: "redeemed" }, { status: 410 });
      r.status = "redeemed";
      r.grantId = `mcp_${redeem[1]}`;
      grants.set(r.grantId, true);
      // the real origin returns the grant with its toolScope (null = all tools)
      return Response.json({ grant: { id: r.grantId, toolScope: null } });
    }
    const check = /^\/api\/auth\/mcp\/grants\/([^/]+)\/check$/.exec(path);
    if (check && init?.method === "POST") {
      checks.push(check[1]!);
      if (grants.get(check[1]!)) return Response.json({ live: true, grant: { id: check[1], toolScope: null } });
      return Response.json({ live: false }, { status: 410 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { stub, originFetch };
}

function setup(clientsFile?: string) {
  const app = new Hono();
  const { stub, originFetch } = stubOrigin();
  const store = installOAuth(app, {
    publicUrl: BASE, token: TOKEN,
    originUrl: ORIGIN, bridgeToken: BRIDGE, bridgeLabel: "Test Mac",
    clientsFile, originFetch,
  });
  return { app, store, stub };
}

const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = "verifier-verifier-verifier-verifier-verifier-12";
const challenge = b64u(createHash("sha256").update(verifier).digest());

async function register(app: Hono, redirectUri = "https://grok.com/oauth/callback", name = "Grok") {
  const res = await app.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], ...(name ? { client_name: name } : {}) }),
  });
  expect(res.status).toBe(201);
  return { ...(await res.json() as { client_id: string; client_name?: string }), redirectUri };
}

const authorizeUrl = (clientId: string, redirectUri: string) => `/authorize?${new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: redirectUri,
  scope: "mcp", state: "s1", code_challenge: challenge, code_challenge_method: "S256",
})}`;

/** The browser leg, minus the human: authorize → origin consent → callback → code. */
async function consent(app: Hono, stub: ReturnType<typeof setup>["stub"], clientId: string, redirectUri: string) {
  const toOrigin = await app.request(authorizeUrl(clientId, redirectUri));
  expect(toOrigin.status).toBe(302);
  const consentUrl = new URL(toOrigin.headers.get("location")!);
  expect(consentUrl.origin).toBe(ORIGIN);
  const requestId = consentUrl.pathname.split("/").at(-1)!;
  const grant = stub.approve(requestId);
  const back = await app.request(`/consent/callback?request=${requestId}&grant=${encodeURIComponent(grant)}`);
  expect(back.status).toBe(302);
  const loc = new URL(back.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(redirectUri);
  expect(loc.searchParams.get("state")).toBe("s1");
  return { requestId, code: loc.searchParams.get("code")! };
}

async function redeem(app: Hono, code: string, clientId: string, redirectUri: string, v = verifier) {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: redirectUri, code_verifier: v,
  });
  return app.request("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
  });
}

async function refresh(app: Hono, refreshToken: string, clientId: string) {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  return app.request("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
  });
}

describe("oauth discovery", () => {
  test("authorization server metadata advertises the PKCE code flow", async () => {
    const { app } = setup();
    const m = await (await app.request("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(m.issuer).toBe(BASE);
    expect(m.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(m.token_endpoint).toBe(`${BASE}/token`);
    expect(m.registration_endpoint).toBe(`${BASE}/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("protected resource metadata points at the MCP endpoint", async () => {
    const { app } = setup();
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const m = await (await app.request(p)).json() as Record<string, unknown>;
      expect(m.resource).toBe(`${BASE}/mcp`);
      expect(m.authorization_servers).toEqual([BASE]);
    }
  });
});

describe("oauth flow", () => {
  test("register → origin consent → code → token → bearer works", async () => {
    const { app, store, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const { requestId, code } = await consent(app, stub, client_id, redirectUri);

    // the bridge told the origin who is asking and where the browser returns
    expect(stub.creates).toHaveLength(1);
    expect(stub.creates[0]).toMatchObject({
      bridgeLabel: "Test Mac", clientName: "Grok",
      redirectUri, callbackUrl: `${BASE}/consent/callback`, scope: "mcp",
    });
    expect(store.pending.has(requestId)).toBe(false); // consumed by the callback

    const tok = await redeem(app, code, client_id, redirectUri);
    expect(tok.status).toBe(200);
    const t = await tok.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(ACCESS_TOKEN_TTL_SEC);
    expect(ACCESS_TOKEN_TTL_SEC).toBe(300); // the documented revocation bound
    expect(store.validAccess(t.access_token)).toBe(true);

    // minted token authorizes; refresh revalidates the grant, then rotates
    const req = new Request("https://tunnel.example.com/mcp", { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(authorized(req, store, TOKEN)).toBe(true);
    const ref = await refresh(app, t.refresh_token, client_id);
    expect(ref.status).toBe(200);
    expect(stub.checks).toEqual(["mcp_mreq_1"]);
    const rj = await ref.json() as { access_token: string; refresh_token: string };
    expect(store.validAccess(rj.access_token)).toBe(true);
    // rotation: the spent refresh token is dead, the new one lives
    expect((await refresh(app, t.refresh_token, client_id)).status).toBe(400);
    const next = await refresh(app, rj.refresh_token, client_id);
    expect(next.status).toBe(200);
    // binding: a live token with no client_id is still refused (and preserved)
    const live = (await next.json() as { refresh_token: string }).refresh_token;
    const anon = new URLSearchParams({ grant_type: "refresh_token", refresh_token: live });
    expect((await app.request("/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: anon.toString(),
    })).status).toBe(400);
    expect((await refresh(app, live, client_id)).status).toBe(200);
  });

  test("revoking the grant refuses refresh while the live access token runs out (the bound)", async () => {
    const { app, store, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const { code } = await consent(app, stub, client_id, redirectUri);
    const t = await (await redeem(app, code, client_id, redirectUri)).json() as {
      access_token: string; refresh_token: string;
    };
    stub.revokeGrant("mcp_mreq_1");

    // refresh dies immediately, and the spent token stays dead
    expect((await refresh(app, t.refresh_token, client_id)).status).toBe(400);
    expect((await refresh(app, t.refresh_token, client_id)).status).toBe(400);
    // the live access token still authorizes: the bound is its TTL, not zero
    const req = new Request("https://tunnel.example.com/mcp", { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(authorized(req, store, TOKEN)).toBe(true);
    // …and nothing else: past expiry the connector is dead until fresh consent
    store.access.get(t.access_token)!.exp = Date.now() - 1;
    expect(authorized(req, store, TOKEN)).toBe(false);
  });

  test("an unreachable origin at refresh is 503 and preserves the token", async () => {
    const { app, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const { code } = await consent(app, stub, client_id, redirectUri);
    const t = await (await redeem(app, code, client_id, redirectUri)).json() as { refresh_token: string };
    stub.down = true;
    expect((await refresh(app, t.refresh_token, client_id)).status).toBe(503);
    stub.down = false;
    expect((await refresh(app, t.refresh_token, client_id)).status).toBe(200);
  });

  test("deny relays access_denied to the client and drops the pending request", async () => {
    const { app, store, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const toOrigin = await app.request(authorizeUrl(client_id, redirectUri));
    const requestId = new URL(toOrigin.headers.get("location")!).pathname.split("/").at(-1)!;
    stub.deny(requestId);
    const back = await app.request(`/consent/callback?request=${requestId}&error=access_denied`);
    expect(back.status).toBe(302);
    const loc = new URL(back.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(store.pending.has(requestId)).toBe(false);
    expect((await app.request(`/consent/callback?request=${requestId}&error=access_denied`)).status).toBe(410);
  });

  test("a failed redeem keeps the pending request: refresh retries it", async () => {
    const { app, store, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const toOrigin = await app.request(authorizeUrl(client_id, redirectUri));
    const requestId = new URL(toOrigin.headers.get("location")!).pathname.split("/").at(-1)!;
    const grant = stub.approve(requestId);
    const bad = await app.request(`/consent/callback?request=${requestId}&grant=wrong`);
    expect(bad.status).toBe(502);
    expect(store.pending.has(requestId)).toBe(true);
    const retry = await app.request(`/consent/callback?request=${requestId}&grant=${encodeURIComponent(grant)}`);
    expect(retry.status).toBe(302);
    expect(new URL(retry.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  test("origin outages fail closed with honest pages", async () => {
    const { app, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    stub.down = true;
    const res = await app.request(authorizeUrl(client_id, redirectUri));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("account server");

    const bare = new Hono();
    installOAuth(bare, {
      publicUrl: BASE, token: TOKEN, originUrl: ORIGIN,
      bridgeToken: "", bridgeLabel: "Test Mac", originFetch: async () => { throw new Error("unreached"); },
    });
    const c = await bare.request("/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    const id = (await c.json() as { client_id: string }).client_id;
    const unconfigured = await bare.request(authorizeUrl(id, redirectUri));
    expect(unconfigured.status).toBe(503);
  });

  test("registration refuses non-https, fragments and garbage redirects", async () => {
    const { app } = setup();
    for (const u of ["http://evil.example/cb", "https://ok.example/cb#frag", "not a url", "javascript:alert(1)"]) {
      const res = await app.request("/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [u] }),
      });
      expect(res.status).toBe(400);
    }
    const local = await app.request("/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"] }),
    });
    expect(local.status).toBe(201);
  });

  test("registration names the client for the consent screen", async () => {
    const { app, stub } = setup();
    const named = await register(app, "https://grok.com/oauth/callback", "Grok");
    expect(named.client_name).toBe("Grok");
    await app.request(authorizeUrl(named.client_id, named.redirectUri));
    expect(stub.creates[0]).toMatchObject({ clientName: "Grok" });

    const anon = await register(app, "https://grok.com/other", "");
    expect(anon.client_name).toBeUndefined();
    await app.request(authorizeUrl(anon.client_id, anon.redirectUri));
    expect(stub.creates[1]).toMatchObject({ clientName: "" });
  });

  test("authorize reflects nothing: it only redirects to the origin consent page", async () => {
    const { app } = setup();
    const { client_id, redirectUri } = await register(app);
    const res = await app.request(authorizeUrl(client_id, redirectUri) + `&x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.test\/api\/auth\/mcp\/requests\/mreq_\d+$/);
  });

  test("non-mcp scopes and plain PKCE are redirected as errors, never consent", async () => {
    const { app } = setup();
    const { client_id, redirectUri } = await register(app);
    const scope = await app.request(`/authorize?${new URLSearchParams({
      response_type: "code", client_id, redirect_uri: redirectUri, scope: "admin",
      state: "s1", code_challenge: challenge, code_challenge_method: "S256",
    })}`);
    expect(scope.status).toBe(302);
    expect(new URL(scope.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    const plain = await app.request(`/authorize?${new URLSearchParams({
      response_type: "code", client_id, redirect_uri: redirectUri, code_challenge: "x", code_challenge_method: "plain",
    })}`);
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  test("code redemption fails closed: wrong verifier, reused code, wrong client", async () => {
    const { app, stub } = setup();
    const { client_id, redirectUri } = await register(app);
    const { code } = await consent(app, stub, client_id, redirectUri);
    expect((await redeem(app, code, client_id, redirectUri, "wrong-verifier-wrong-verifier-wrong-12")).status).toBe(400);
  });

  test("unknown client or redirect_uri never reaches consent", async () => {
    const { app } = setup();
    const res = await app.request(`/authorize?${new URLSearchParams({
      response_type: "code", client_id: "c_nope", redirect_uri: "https://evil.example/cb",
      code_challenge: challenge, code_challenge_method: "S256",
    })}`);
    expect(res.status).toBe(400);
  });

  test("unknown consent callbacks are gone, not errors", async () => {
    const { app } = setup();
    const res = await app.request("/consent/callback?request=mreq_nope&grant=x");
    expect(res.status).toBe(410);
  });
});

describe("bearer", () => {
  test("raw operator token authorizes; absent or wrong does not", () => {
    const store = new OAuthStore();
    const withT = (t?: string) => new Request("http://x/mcp", t ? { headers: { authorization: t } } : {});
    expect(bearerToken(withT(`Bearer ${TOKEN}`))).toBe(TOKEN);
    expect(authorized(withT(`Bearer ${TOKEN}`), store, TOKEN)).toBe(true);
    expect(authorized(withT("Bearer wrong"), store, TOKEN)).toBe(false);
    expect(authorized(withT(), store, TOKEN)).toBe(false);
  });
});

describe("durable client registrations", () => {
  test("a real HTTP bridge restart keeps the client's PKCE flow, but no old credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-restart-"));
    const clientsFile = join(dir, "private", "clients.json");
    const { stub, originFetch } = stubOrigin();
    const make = () => createMcpApp({
      lookoutUrl: "http://127.0.0.1:1", publicUrl: BASE, originUrl: ORIGIN,
      token: TOKEN, bridgeToken: BRIDGE, bridgeLabel: "Test Mac", roots: [],
      clientsFile, originFetch,
    });
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const first = make();
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: first.app.fetch });
      let url = `http://127.0.0.1:${server.port}`;
      const registration = await fetch(`${url}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Grok", redirect_uris: ["https://grok.com/oauth/callback"] }),
      });
      expect(registration.status).toBe(201);
      const { client_id } = await registration.json() as { client_id: string };
      const redirectUri = "https://grok.com/oauth/callback";
      const { code } = await consent(first.app, stub, client_id, redirectUri);
      const old = await (await redeem(first.app, code, client_id, redirectUri)).json() as {
        access_token: string; refresh_token: string;
      };
      const unusedCode = (await consent(first.app, stub, client_id, redirectUri)).code;
      const pending = await first.app.request(authorizeUrl(client_id, redirectUri));
      const pendingId = new URL(pending.headers.get("location")!).pathname.split("/").at(-1)!;
      server.stop(true);
      server = undefined;

      const second = make();
      expect(second.oauth.clients.has(client_id)).toBe(true);
      expect(second.oauth.codes.size + second.oauth.access.size + second.oauth.refresh.size + second.oauth.pending.size).toBe(0);
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: second.app.fetch });
      url = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${old.access_token}` } })).status).toBe(401);
      expect((await refresh(second.app, old.refresh_token, client_id)).status).toBe(400);
      expect((await redeem(second.app, unusedCode, client_id, redirectUri)).status).toBe(400);
      expect((await second.app.request(`/consent/callback?request=${pendingId}&grant=x`)).status).toBe(410);

      // The consumer reuses its saved registration: no second DCR is needed.
      const auth = await fetch(url + authorizeUrl(client_id, redirectUri), { redirect: "manual" });
      expect(auth.status).toBe(302);
      const requestId = new URL(auth.headers.get("location")!).pathname.split("/").at(-1)!;
      const grant = stub.approve(requestId);
      const callback = await fetch(`${url}/consent/callback?${new URLSearchParams({ request: requestId, grant })}`, { redirect: "manual" });
      expect(callback.status).toBe(302);
      const returnUrl = new URL(callback.headers.get("location")!);
      expect(returnUrl.origin + returnUrl.pathname).toBe(redirectUri);
      const token = await fetch(`${url}/token`, {
        method: "POST", body: new URLSearchParams({
          grant_type: "authorization_code", client_id, redirect_uri: redirectUri,
          code: returnUrl.searchParams.get("code")!, code_verifier: verifier,
        }),
      });
      expect(token.status).toBe(200);
      const fresh = await token.json() as { access_token: string };
      const init = await fetch(`${url}/mcp`, {
        method: "POST", headers: {
          authorization: `Bearer ${fresh.access_token}`, "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "restart-proof", version: "1" },
        } }),
      });
      expect(init.status).toBe(200);
      expect((await init.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("lookout");
      expect((await second.app.request(authorizeUrl(client_id, "https://grok.com/other"))).status).toBe(400);
      const bytes = readFileSync(clientsFile, "utf8");
      expect(JSON.parse(bytes).clients).toHaveLength(1);
      for (const secret of [old.access_token, old.refresh_token, unusedCode, pendingId, fresh.access_token]) expect(bytes).not.toContain(secret);
      expect(statSync(dirname(clientsFile)).mode & 0o777).toBe(0o700);
      expect(statSync(clientsFile).mode & 0o777).toBe(0o600);
    } finally {
      server?.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt or invalid registry refuses DCR and preserves the original bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-corrupt-"));
    const file = join(dir, "clients.json");
    const good = { client_id: "c_1234567890abcdef", client_name: "Grok", redirect_uris: ["https://grok.com/callback"] };
    const badFiles = [
      "{not json", "null", JSON.stringify({ version: 2, clients: [good] }),
      JSON.stringify({ version: 1, clients: [good, good] }),
      JSON.stringify({ version: 1, clients: [{ ...good, client_id: "unminted" }] }),
      JSON.stringify({ version: 1, clients: [{ ...good, redirect_uris: ["http://evil.example/callback"] }] }),
      JSON.stringify({ version: 1, clients: [{ ...good, redirect_uris: ["https://grok.com/callback#fragment"] }] }),
    ];
    try {
      for (const bytes of badFiles) {
        writeFileSync(file, bytes);
        const { app, store } = setup(file);
        expect(store.clients.size).toBe(0);
        expect(store.registrationError).not.toBeNull();
        const r = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://grok.com/callback"] }) });
        expect(r.status).toBe(503);
        expect(readFileSync(file, "utf8")).toBe(bytes);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a failed atomic write returns failure without phantom registration or temporary files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-write-fail-"));
    const file = join(dir, "clients.json");
    try {
      // Missing at boot, then a directory takes its place: rename must fail.
      const { app, store } = setup(file);
      mkdirSync(file);
      const r = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://grok.com/callback"] }) });
      expect(r.status).toBe(500);
      expect(store.clients.size).toBe(0);
      expect(readdirSync(dir)).toEqual(["clients.json"]);
      expect(statSync(file).isDirectory()).toBe(true);
      rmSync(file, { recursive: true });
      expect((await register(app)).client_id).toMatch(/^c_/);
      expect(new OAuthStore({ clientsFile: file }).clients.size).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("only the registry file is made private; an existing config directory keeps its mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-permissions-"));
    try {
      chmodSync(dir, 0o755);
      const file = join(dir, "clients.json");
      const { app } = setup(file);
      await register(app);
      chmodSync(file, 0o644);
      await register(app, "http://127.0.0.1:3333/callback");
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(new OAuthStore({ clientsFile: file }).clients.size).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
