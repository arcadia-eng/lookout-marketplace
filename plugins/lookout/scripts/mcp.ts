#!/usr/bin/env bun
// Claude Code's MCP entry. Starts the Lookout bridge on stdio whenever this
// machine has one (a checkout, or the installed app's own copy), at once and
// whether or not Lookout is running: the bridge lists its tools from its own
// manifest and answers each call with "Lookout is not running" until the app
// is up, so Claude Code never caches a failed server and nothing needs
// /plugin to come back. Without a bridge on disk: the HTTP bridge already
// listening, or the hosted MCP with the saved OAuth token. Does not bind 8789
// or 8792.

import { createInterface } from "node:readline";
import { findBridge, type Bridge } from "../src/bridge-path.js";
import { probeApp, probeBridge } from "../src/local.js";
import { ensureAccess, findOAuth, oauthPath, refreshAccess, writeOAuthFile, type StoredOAuth } from "../src/oauth.js";
import { forwardRpc } from "../src/proxy.js";
import { chooseTarget, LOCAL_APP_URL, LOCAL_BRIDGE_ORIGIN, resolveTarget, type Target } from "../src/target.js";
import { readBearer } from "../src/token.js";

const env = process.env;

function starts(): string[] {
  return [env.LOOKOUT_ROOT ?? "", env.CLAUDE_PLUGIN_ROOT ?? "", import.meta.dir, process.cwd()];
}

async function probe(): Promise<{ appUp: boolean; bridgeUp: boolean }> {
  if (env.LOOKOUT_URL?.trim()) return { appUp: false, bridgeUp: false };
  const [appUp, bridgeUp] = await Promise.all([
    probeApp(LOCAL_APP_URL),
    probeBridge(LOCAL_BRIDGE_ORIGIN),
  ]);
  return { appUp, bridgeUp };
}

async function runStdio(bridge: Bridge, lookoutUrl: string): Promise<void> {
  console.error(`lookout mcp: stdio bridge (${bridge.entry}) → ${lookoutUrl}`);
  const proc = Bun.spawn([bridge.bun, bridge.entry], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...env, LOOKOUT_URL: lookoutUrl, LOOKOUT_MCP_VIA: env.LOOKOUT_MCP_VIA?.trim() || "Claude Code", LOOKOUT_MCP_CLIENT_ID: env.LOOKOUT_MCP_CLIENT_ID?.trim() || "claude-code" },
  });
  const code = await proc.exited;
  process.exit(code ?? 1);
}

function write(message: unknown) {
  if (message === null || message === undefined) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function bearerFor(target: Target, stored: StoredOAuth | null, path: string): Promise<{ token: string | null; stored: StoredOAuth | null }> {
  if (target.mode === "http") {
    const read = readBearer(env);
    if (read.error) console.error(`lookout mcp: ${read.error}`);
    if (!read.token) console.error("lookout mcp: local bridge is up but no bearer was found. Set LOOKOUT_MCP_TOKEN. Nothing secret was printed.");
    return { token: read.token, stored };
  }
  if (target.mode !== "remote" || !stored) return { token: null, stored };
  try {
    const next = await ensureAccess(stored);
    if (next !== stored && next.accessToken !== stored.accessToken) {
      try { writeOAuthFile(path, next); } catch { /* the in-memory token still works this process */ }
    }
    return { token: next.accessToken ?? null, stored: next };
  } catch (e) {
    console.error(`lookout mcp: ${e instanceof Error ? e.message : "could not refresh the remote sign-in"}`);
    return { token: stored.accessToken ?? null, stored };
  }
}

async function proxy(target: Extract<Target, { mode: "http" | "remote" }>) {
  const where = target.mode === "http" ? target.mcpUrl : target.mcpUrl;
  console.error(`lookout mcp: ${target.mode} → ${where}`);
  // the sign-in and the file it came from: Claude's plugin data dir (/lookout:login), else the shared config file
  const found = target.mode === "remote" ? findOAuth(env) : null;
  let path = found?.path ?? oauthPath(env);
  let stored = found?.stored ?? null;
  let auth = await bearerFor(target, stored, path);
  stored = auth.stored;
  let sessionId: string | null = null;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try { message = JSON.parse(trimmed); } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    let result = await forwardRpc(message, { mcpUrl: target.mcpUrl, token: auth.token, sessionId });
    if (result.status === 0) {
      // unreachable: answer the call with the reason and keep this process up; the next call tries again
      const isRequest = !!message && typeof message === "object" && "id" in message;
      if (isRequest) write(result.response);
      continue;
    }
    // a sign-in saved since this process started (/lookout:login) is taken up here, no restart needed
    const signedIn = result.status === 401 && target.mode === "remote" ? findOAuth(env) : null;
    if (signedIn && signedIn.stored.accessToken !== stored?.accessToken) {
      path = signedIn.path;
      auth = await bearerFor(target, signedIn.stored, path);
      stored = auth.stored;
      result = await forwardRpc(message, { mcpUrl: target.mcpUrl, token: auth.token, sessionId });
    } else if (result.status === 401 && target.mode === "remote" && stored?.refreshToken) {
      try {
        stored = await refreshAccess(stored);
        writeOAuthFile(path, stored);
        auth = { token: stored.accessToken ?? null, stored };
        result = await forwardRpc(message, { mcpUrl: target.mcpUrl, token: auth.token, sessionId });
      } catch (e) {
        console.error(`lookout mcp: ${e instanceof Error ? e.message : "refresh failed"}`);
      }
    }
    sessionId = result.sessionId;
    const isRequest = !!message && typeof message === "object" && "id" in message;
    if (isRequest) write(result.response);
  }
}

// The bridge on disk decides first: with one, no probe (and no wait) at all.
const bridge = env.LOOKOUT_MCP_REMOTE === "1" ? null : findBridge(starts());
const probeResult = bridge ? null : await probe();
const chosen = chooseTarget(env, probeResult, { stdioOnDisk: !!bridge });
const resolved = resolveTarget(chosen, { stdioEntry: bridge?.entry ?? null, bridgeUp: probeResult?.bridgeUp ?? false });

if (resolved.mode === "missing") {
  console.error(`lookout mcp: ${resolved.reason}`);
  process.exit(1);
}
if (resolved.mode === "stdio") {
  if (!bridge) {
    console.error("lookout mcp: stdio entry disappeared");
    process.exit(1);
  }
  await runStdio(bridge, resolved.lookoutUrl);
} else {
  await proxy(resolved);
}
