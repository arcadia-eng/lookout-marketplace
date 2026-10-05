#!/usr/bin/env bun
// SessionStart: if the local app has Lookout chats running, tell the
// session. Silent when it doesn't, so a session that isn't using Lookout
// stays quiet. Never fails the session.

import { fleetLines, liveLanes, type LaneSnap } from "../src/format.js";
import { localGet } from "../src/local.js";
import { LOCAL_APP_URL } from "../src/target.js";

try {
  const base = (process.env.LOOKOUT_URL ?? LOCAL_APP_URL).replace(/\/$/, "");
  const body = await localGet(base, "/api/lanes?limit=30", 1500);
  const lanes = body && typeof body === "object" && Array.isArray((body as { lanes?: unknown }).lanes)
    ? (body as { lanes: LaneSnap[] }).lanes
    : [];
  if (!liveLanes(lanes).length) process.exit(0);
  const text = ["Lookout work already running:", ...fleetLines(lanes)].join("\n");
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  })}\n`);
} catch {
  process.exit(0);
}
