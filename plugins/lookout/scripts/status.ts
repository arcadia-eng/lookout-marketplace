#!/usr/bin/env bun
// /lookout:status against the local app. Prints a fixed report. When the
// app is down, says so and stops: the command then uses the MCP tools,
// which cover the remote account too.

import { renderStatus, type LaneSnap, type MachineSnap, type ProviderSnap } from "../src/format.js";
import { localGet } from "../src/local.js";
import { LOCAL_APP_URL } from "../src/target.js";

const base = (process.env.LOOKOUT_URL ?? LOCAL_APP_URL).replace(/\/$/, "");
const health = await localGet(base, "/api/health", 1500);
if (!health) {
  console.log(`Local Lookout is not answering at ${base}. Use the lookout MCP tools (lookout_status, lookout_machines, lookout_usage) for the remote account.`);
  process.exit(0);
}

const [lanesBody, machinesBody, providersBody] = await Promise.all([
  localGet(base, "/api/lanes?limit=30", 2500),
  localGet(base, "/api/network/machines", 2500),
  localGet(base, "/api/providers?refresh=none", 2500),
]);

const notes: string[] = [];
const lanes = lanesBody && typeof lanesBody === "object" && Array.isArray((lanesBody as { lanes?: unknown }).lanes)
  ? (lanesBody as { lanes: LaneSnap[] }).lanes
  : [];
if (!lanesBody) notes.push("Chats: the lanes read failed.");

const machines = machinesBody && typeof machinesBody === "object" && Array.isArray((machinesBody as { machines?: unknown }).machines)
  ? (machinesBody as { machines: MachineSnap[] }).machines
  : [];
if (!machinesBody) notes.push("Machines: not available from this app (signed out, or the network is off).");

const providers = providersBody && typeof providersBody === "object" && Array.isArray((providersBody as { providers?: unknown }).providers)
  ? (providersBody as { providers: ProviderSnap[] }).providers
  : [];
if (!providersBody) notes.push("Quotas: GET /api/providers failed.");

console.log(renderStatus({ app: base, lanes, machines, providers, notes }));
