#!/usr/bin/env bun
// Sign this plugin in to the hosted Lookout MCP (OAuth, PKCE, loopback
// redirect). In Claude Code it runs as /lookout:login, which hands it the
// plugin data dir (CLAUDE_PLUGIN_DATA is not in the Bash tool's environment);
// from a terminal the tokens go to ~/.config/lookout/claude-plugin-oauth.json,
// which the MCP entry reads too. Mode 0600, never printed. The local app does
// not need this: stdio and the local bridge use the machine's own Lookout.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { exchangeCode, oauthPath, pkcePair, writeOAuthFile } from "../src/oauth.js";
import { REMOTE_MCP_URL } from "../src/target.js";

const mcpUrl = (process.env.LOOKOUT_MCP_REMOTE_URL ?? REMOTE_MCP_URL).replace(/\/$/, "");
const origin = new URL(mcpUrl).origin;

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
}

const metaRes = await fetch(`${origin}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
if (!metaRes.ok) {
  console.error(`login: discovery failed (HTTP ${metaRes.status}) at ${origin}`);
  process.exit(1);
}
const meta = await metaRes.json() as { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string };
if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
  console.error("login: the server's OAuth metadata is missing an endpoint");
  process.exit(1);
}

const server = createServer();
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") {
  console.error("login: could not bind a loopback port");
  process.exit(1);
}
const redirectUri = `http://127.0.0.1:${address.port}/callback`;

const reg = await fetch(meta.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({
    redirect_uris: [redirectUri],
    client_name: "Claude Code (Lookout)",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const registered = await reg.json().catch(() => null) as { client_id?: string; error?: string } | null;
if (!reg.ok || !registered?.client_id) {
  console.error(`login: client registration failed (${registered?.error ?? `HTTP ${reg.status}`})`);
  server.close();
  process.exit(1);
}

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString("base64url");
const authUrl = new URL(meta.authorization_endpoint);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", registered.client_id);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("scope", "mcp");
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");

let code: string;
try {
  code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => {
    server.close();
    reject(new Error("timed out waiting for the browser (10 minutes)"));
  }, 10 * 60 * 1000);
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const got = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    if (got !== state || err || !value) {
      res.writeHead(400, { "content-type": "text/plain" }).end(err ? `Lookout sign-in was declined (${err}).` : "Lookout sign-in did not complete.");
      clearTimeout(timer);
      server.close();
      reject(new Error(err ? `sign-in declined (${err})` : "sign-in did not complete"));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("Lookout is signed in. You can close this tab.");
    clearTimeout(timer);
    server.close();
    resolve(value);
  });
  console.error("login: opening the browser. If it does not, open this URL yourself:");
  console.error(authUrl.toString());
  openBrowser(authUrl.toString());
  });
} catch (e) {
  console.error(`login: ${e instanceof Error ? e.message : "sign-in failed"}`);
  process.exit(1);
}

try {
  const stored = await exchangeCode({
    mcpUrl,
    tokenEndpoint: meta.token_endpoint,
    clientId: registered.client_id,
    redirectUri,
  }, code, verifier);
  const path = oauthPath(process.env);
  writeOAuthFile(path, stored);
  console.error(`login: signed in. Tokens saved (${path}). They were not printed.`);
} catch (e) {
  console.error(`login: ${e instanceof Error ? e.message : "token exchange failed"}`);
  process.exit(1);
}
