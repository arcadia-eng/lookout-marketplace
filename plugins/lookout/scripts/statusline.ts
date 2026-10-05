#!/usr/bin/env bun
// Subagent status line segment. One short line, or nothing when Lookout
// has no running chats (and nothing when the local app is down).

import { runningSegment, type LaneSnap } from "../src/format.js";
import { localGet } from "../src/local.js";
import { LOCAL_APP_URL } from "../src/target.js";

try {
  const base = (process.env.LOOKOUT_URL ?? LOCAL_APP_URL).replace(/\/$/, "");
  const body = await localGet(base, "/api/lanes?limit=30", 800);
  const lanes = body && typeof body === "object" && Array.isArray((body as { lanes?: unknown }).lanes)
    ? (body as { lanes: LaneSnap[] }).lanes
    : [];
  const line = runningSegment(lanes);
  if (line) process.stdout.write(`${line}\n`);
} catch {
  /* a status line that throws is worse than a blank one */
}
process.exit(0);
