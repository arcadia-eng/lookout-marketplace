// Loopback reads of the Lookout app. The headers are the same contract the
// MCP bridge sends (`x-lookout-client: mcp`, and the app session from the
// home's app-session.key: src/server/ontology/principal.ts forwardedHeaders).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIENT_HEADER = "x-lookout-client";
/** The header the app's server admits a local client by (principal.ts SESSION_HEADER). */
export const SESSION_HEADER = "x-lookout-session";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The app session this machine's Lookout home holds (LOOKOUT_HOME, else ~/.lookout), for a loopback base only:
 * the app's server answers no /api request without it. Empty before the app has ever run.
 */
export function sessionHeaders(base: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  let host: string;
  try { host = new URL(base).hostname; } catch { return {}; }
  if (!LOOPBACK.has(host)) return {};
  try {
    const secret = readFileSync(join(env.LOOKOUT_HOME?.trim() || join(homedir(), ".lookout"), "app-session.key"), "utf8").trim();
    return secret ? { [SESSION_HEADER]: secret } : {};
  } catch { return {}; }
}

export async function localGet(base: string, path: string, ms: number, fetchFn: typeof fetch = fetch): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`, {
      headers: { [CLIENT_HEADER]: "mcp", accept: "application/json", ...sessionHeaders(base) },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeApp(base: string, ms = 400, fetchFn?: typeof fetch): Promise<boolean> {
  const body = await localGet(base, "/api/health", ms, fetchFn);
  return !!body && typeof body === "object";
}

export async function probeBridge(origin: string, ms = 400, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const body = await localGet(origin, "/health", ms, fetchFn);
  return !!body && typeof body === "object" && (body as { service?: string }).service === "lookout-mcp";
}
