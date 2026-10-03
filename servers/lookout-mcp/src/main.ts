#!/usr/bin/env bun
// Executable entry: `bun src/main.ts`, or the packed bin (`bunx lookout-mcp`
// / `bunx @arcadia/lookout-mcp`): the shebang above makes the linked file
// executable wherever Bun is installed.
// LOOKOUT_MCP_TOKEN is required: a public URL without a gate would be
// remote code execution. Human sign-in is the Lookout account (origin
// consent); the token is only the raw Bearer for the local Inspector/tests,
// and LOOKOUT_MCP_BRIDGE_TOKEN authenticates the bridge's server-to-server
// origin calls.
// Client registrations persist (LOOKOUT_MCP_CLIENTS_FILE, default
// ~/.config/lookout/mcp/clients.json) so a bridge restart doesn't orphan
// the connector's dynamic client; tokens and consent state stay ephemeral.
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "./paths.js";
import { createMcpApp } from "./app.js";

const port = Number(process.env.LOOKOUT_MCP_PORT ?? 8792);
const token = process.env.LOOKOUT_MCP_TOKEN ?? "";
if (!token) {
  console.error("LOOKOUT_MCP_TOKEN is required (raw Bearer for local dev + tests).");
  process.exit(1);
}
const bridgeToken = process.env.LOOKOUT_MCP_BRIDGE_TOKEN ?? "";
if (!bridgeToken)
  console.error("LOOKOUT_MCP_BRIDGE_TOKEN is unset: browser consent is unavailable until it is set (raw Bearer still works).");
const publicUrl = (process.env.LOOKOUT_MCP_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
const originUrl = (process.env.LOOKOUT_MCP_ORIGIN_URL ?? "https://arcadiausercontent.com").replace(/\/$/, "");
const bridgeLabel = process.env.LOOKOUT_MCP_BRIDGE_LABEL?.trim() || hostname();
const roots = (process.env.LOOKOUT_MCP_ROOTS ?? "").split(",").map(s => s.trim()).filter(Boolean).map(canonicalPath);
// Durable client registrations live in their own private dir beside the
// bridge token's config dir; XDG_CONFIG_HOME is honored so the file lands
// wherever the deploy puts it.
const clientsFile = process.env.LOOKOUT_MCP_CLIENTS_FILE?.trim()
  || join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "lookout", "mcp", "clients.json");

const { app } = createMcpApp({
  lookoutUrl: process.env.LOOKOUT_URL ?? "http://127.0.0.1:8789",
  publicUrl, token, originUrl, bridgeToken, bridgeLabel, roots, clientsFile,
});

export default { port, hostname: "127.0.0.1", fetch: app.fetch };
console.log(`lookout-mcp on :${port} → ${process.env.LOOKOUT_URL ?? "http://127.0.0.1:8789"} (public ${publicUrl}, origin ${originUrl}, bridge "${bridgeLabel}", clients ${clientsFile}, roots: ${roots.join(", ") || "(projects only)"})`);
