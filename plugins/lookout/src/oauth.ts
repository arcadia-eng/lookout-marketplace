import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What login.ts persists. Access tokens are short; refresh is the session. */
export interface StoredOAuth {
  mcpUrl: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "use it until the server says otherwise". */
  expiresAt?: number;
}

export function oauthPath(env: Record<string, string | undefined>, home = homedir()): string {
  if (env.LOOKOUT_MCP_OAUTH_FILE?.trim()) return env.LOOKOUT_MCP_OAUTH_FILE.trim();
  if (env.CLAUDE_PLUGIN_DATA?.trim()) return join(env.CLAUDE_PLUGIN_DATA.trim(), "oauth.json");
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "lookout", "claude-plugin-oauth.json");
}

export function loadOAuth(text: string): StoredOAuth | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.mcpUrl !== "string" || typeof o.tokenEndpoint !== "string" || typeof o.clientId !== "string") return null;
  if (typeof o.redirectUri !== "string") return null;
  return {
    mcpUrl: o.mcpUrl,
    tokenEndpoint: o.tokenEndpoint,
    clientId: o.clientId,
    redirectUri: o.redirectUri,
    ...(typeof o.accessToken === "string" ? { accessToken: o.accessToken } : {}),
    ...(typeof o.refreshToken === "string" ? { refreshToken: o.refreshToken } : {}),
    ...(typeof o.expiresAt === "number" ? { expiresAt: o.expiresAt } : {}),
  };
}

export function readOAuthFile(path: string): StoredOAuth | null {
  try { return loadOAuth(readFileSync(path, "utf8")); } catch { return null; }
}

/** Mode 0600, temp-then-rename. Callers pass a path they are allowed to own. */
export function writeOAuthFile(path: string, stored: StoredOAuth): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  renameSync(tmp, path);
}

/** RFC 7636 S256. Verifier is base64url of 32 random bytes unless one is given. */
export function pkcePair(verifier = randomBytes(32).toString("base64url")): { verifier: string; challenge: string } {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const SKEW_MS = 30_000;

export function accessUsable(stored: StoredOAuth, now = Date.now()): boolean {
  if (!stored.accessToken) return false;
  if (stored.expiresAt === undefined) return true;
  return stored.expiresAt - now > SKEW_MS;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

interface TokenJson {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

function applyToken(stored: StoredOAuth, json: TokenJson, now: number): StoredOAuth {
  if (typeof json.access_token !== "string" || !json.access_token) {
    const err = typeof json.error === "string" ? json.error : "no access_token";
    throw new OAuthError(`token request failed: ${err}`);
  }
  return {
    ...stored,
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.expires_in === "number" ? { expiresAt: now + json.expires_in * 1000 } : {}),
  };
}

async function postForm(url: string, body: URLSearchParams, fetchFn: typeof fetch): Promise<TokenJson> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = (await res.json().catch(() => null)) as TokenJson | null;
  if (!res.ok) {
    const err = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new OAuthError(`token request failed: ${err}`);
  }
  return json ?? {};
}

/** Refresh. The error names the OAuth error code, never either token. */
export async function refreshAccess(stored: StoredOAuth, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<StoredOAuth> {
  if (!stored.refreshToken) throw new OAuthError("not signed in (no refresh token)");
  const json = await postForm(stored.tokenEndpoint, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  }), fetchFn);
  return applyToken(stored, json, now);
}

export async function exchangeCode(
  stored: Pick<StoredOAuth, "tokenEndpoint" | "clientId" | "redirectUri" | "mcpUrl">,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<StoredOAuth> {
  const json = await postForm(stored.tokenEndpoint, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: stored.clientId,
    redirect_uri: stored.redirectUri,
    code_verifier: verifier,
  }), fetchFn);
  return applyToken({ ...stored }, json, now);
}

/** Use the stored access token, refreshing once when it is due or missing. */
export async function ensureAccess(stored: StoredOAuth, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<StoredOAuth> {
  if (accessUsable(stored, now)) return stored;
  return refreshAccess(stored, fetchFn, now);
}
