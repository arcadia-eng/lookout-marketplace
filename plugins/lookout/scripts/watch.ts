#!/usr/bin/env bun
// One line on stdout when a Lookout chat settles or needs a person, then
// exit. Claude Code's Monitor turns that line into a wake-up. Stays quiet
// while the chat is working. Exits by itself before Monitor's 30 minute
// kill so a still-running chat can be armed again.
//
//   bun scripts/watch.ts --thread <id> [--url <lookout>] [--cursor <file>]

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLIENT_HEADER, localGet } from "../src/local.js";
import { deadlineLine, takeSseEvents, unseen, WATCH_MAX_MS, watchLine, type LaneSnap } from "../src/watch.js";

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  return argv[at + 1] ?? null;
}

function laneOf(body: unknown, threadId: string): LaneSnap | null {
  if (!body || typeof body !== "object") return null;
  const lanes = (body as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanes)) return null;
  const row = lanes.find(l => !!l && typeof l === "object" && (l as { threadId?: string }).threadId === threadId) as Record<string, unknown> | undefined;
  if (!row || typeof row.state !== "string") return null;
  const question = row.question && typeof row.question === "object" ? (row.question as { title?: unknown }).title : undefined;
  const last = row.lastReply && typeof row.lastReply === "object" ? (row.lastReply as { text?: unknown }).text : undefined;
  return {
    state: row.state,
    live: row.live === true,
    working: row.working === true,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof question === "string" ? { question } : {}),
    ...(typeof last === "string" ? { lastReply: last } : {}),
  };
}

function readCursor(path: string | null): string | null {
  if (!path) return null;
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function writeCursor(path: string | null, line: string) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, line);
  renameSync(tmp, path);
}

const argv = process.argv.slice(2);
const threadId = flag(argv, "--thread");
if (!threadId) {
  console.error("watch: --thread <id> is required");
  process.exit(2);
}
const base = (flag(argv, "--url") ?? process.env.LOOKOUT_URL ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const cursorPath = flag(argv, "--cursor");
const maxMs = Number(process.env.LOOKOUT_WATCH_MAX_MS ?? WATCH_MAX_MS);
const cursor = readCursor(cursorPath);

function emit(line: string): boolean {
  if (!unseen(cursor, line)) return false;
  process.stdout.write(`${line}\n`);
  writeCursor(cursorPath, line);
  return true;
}

const first = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(threadId)}`, 2000), threadId);
const firstLine = watchLine(threadId, first);
if (firstLine && emit(firstLine)) process.exit(0);

const deadline = Date.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : WATCH_MAX_MS);
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
try {
  const res = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/stream`, {
    headers: { [CLIENT_HEADER]: "mcp", accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    const line = watchLine(threadId, first) ?? `[lookout] ${threadId} could not be watched (HTTP ${res.status}).`;
    emit(line);
    process.exit(0);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (Date.now() >= deadline) {
      emit(deadlineLine(threadId));
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const taken = takeSseEvents(buf);
    buf = taken.rest;
    let settled = false;
    for (const ev of taken.events) {
      let parsed: { kind?: string; live?: boolean } | null = null;
      try { parsed = JSON.parse(ev.data) as { kind?: string; live?: boolean }; } catch { continue; }
      if (parsed?.kind !== "live" || parsed.live !== false) continue;
      const lane = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(threadId)}`, 2000), threadId);
      const line = watchLine(threadId, lane);
      if (line && emit(line)) { settled = true; break; }
    }
    if (settled) break;
  }
} catch {
  if (Date.now() >= deadline) emit(deadlineLine(threadId));
} finally {
  clearTimeout(timer);
}
process.exit(0);
