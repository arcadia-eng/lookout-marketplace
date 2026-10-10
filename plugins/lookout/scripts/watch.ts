#!/usr/bin/env bun
// One line per event over a batch of Lookout chats, or one workflow run,
// then exit when the batch settles or a chat needs an answer. Claude Code's
// Monitor turns each line into a wake-up, and a background command's exit
// wakes the session: arm one watcher per batch, not one per chat. Stays
// quiet while the chats work. Exits by itself before Monitor's 30 minute
// kill so a batch that is still going can be re-armed.
//
//   bun scripts/watch.ts --thread <id>                                       one chat
//   bun scripts/watch.ts --fleet --lane-prefix p [--machines a,b | "*"]      a batch by lane-key prefix
//   bun scripts/watch.ts --machine <name> [--lane-prefix p]                  one remote machine's batch
//   bun scripts/watch.ts --run <wfr_id>                                      one workflow run (this machine)
//
// Every mode takes --url <lookout> (LOOKOUT_URL), --cursor <file> (what the
// last arm saw, so a re-arm prints no event twice) and --until all-settled
// (the only exit mode; it is the default).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLIENT_HEADER, HOLD_HEADER, localGet, machineBase, sessionHeaders } from "../src/local.js";
import {
  deadlineLine, fleetDeadline, fleetStep, fleetSummary, runDeadline, runStep, rowOpen, rowWaitsForPlan, takeSseEvents, unseen,
  WATCH_MAX_MS, watchLine, type FleetRow, type LaneSnap, type RunSnap,
} from "../src/watch.js";

/** The server's longest hold for a lanes or run wait. */
const WAIT_S = 55;

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  return argv[at + 1] ?? null;
}

function usage(message: string): never {
  console.error(`watch: ${message}`);
  process.exit(2);
}

function laneOf(body: unknown, threadId: string): LaneSnap | null {
  if (!body || typeof body !== "object") return null;
  const lanes = (body as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanes)) return null;
  const row = lanes.find(l => !!l && typeof l === "object" && (l as { threadId?: string }).threadId === threadId) as Record<string, unknown> | undefined;
  if (!row || typeof row.state !== "string") return null;
  const question = row.question && typeof row.question === "object" ? (row.question as { title?: unknown }).title : undefined;
  const last = row.lastReply && typeof row.lastReply === "object" ? (row.lastReply as { text?: unknown }).text : undefined;
  const parked = parkedOf(row.parked);
  return {
    state: row.state,
    live: row.live === true,
    working: row.working === true,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof question === "string" ? { question } : {}),
    ...(typeof last === "string" ? { lastReply: last } : {}),
    ...(parked ? { parked } : {}),
  };
}

/** A lane's `parked` (whose plan it waits for, until when), narrowed. */
function parkedOf(v: unknown): LaneSnap["parked"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as { until?: unknown; model?: unknown };
  return { ...(typeof p.until === "number" ? { until: p.until } : {}), ...(typeof p.model === "string" ? { model: p.model } : {}) };
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

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

// --- one API read, with the headers a wait needs -----------------------------------

type Read = { ok: true; body: unknown } | { ok: false; status: number };

async function read(api: string, path: string, o: { ms?: number; waitS?: number; signal?: AbortSignal } = {}): Promise<Read> {
  const waitS = o.waitS ?? 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.ms ?? Math.max(2000, waitS * 1000 + 5000));
  const abortWith = () => ctrl.abort();
  o.signal?.addEventListener("abort", abortWith, { once: true });
  try {
    const res = await fetch(`${api}${path}`, {
      headers: {
        [CLIENT_HEADER]: "mcp",
        accept: "application/json",
        ...sessionHeaders(api),
        ...(waitS > 0 ? { [HOLD_HEADER]: String(waitS) } : {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", abortWith);
  }
}

const why = (o: Read) => (o.ok ? "" : o.status ? `HTTP ${o.status}` : "unreachable");

/** A lanes answer into the rows the fleet step takes. */
function fleetRowsOf(body: unknown): { rows: FleetRow[]; cursor?: string; complete: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const lanes = (body as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanes)) return null;
  const rows: FleetRow[] = [];
  for (const l of lanes) {
    if (!l || typeof l !== "object") continue;
    const r = l as Record<string, unknown>;
    if (typeof r.threadId !== "string" || typeof r.state !== "string") continue;
    const question = r.question && typeof r.question === "object" ? (r.question as { title?: unknown }).title : undefined;
    const last = r.lastReply && typeof r.lastReply === "object" ? (r.lastReply as { text?: unknown }).text : undefined;
    const resetsAt = r.error && typeof r.error === "object" ? (r.error as { resetsAt?: unknown }).resetsAt : undefined;
    const parked = parkedOf(r.parked);
    rows.push({
      ...(parked ? { parked } : {}),
      threadId: r.threadId,
      state: r.state,
      live: r.live === true,
      working: r.working === true,
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(typeof question === "string" ? { question } : {}),
      ...(typeof last === "string" ? { lastReply: last } : {}),
      ...(typeof r.asking === "number" && r.asking > 0 ? { asking: r.asking } : {}),
      ...(typeof r.crashResume === "string" ? { crashResume: r.crashResume } : {}),
      ...(typeof resetsAt === "number" ? { resetsAt } : {}),
    });
  }
  const b = body as { cursor?: unknown; total?: unknown };
  return {
    rows,
    ...(typeof b.cursor === "string" ? { cursor: b.cursor } : {}),
    complete: typeof b.total !== "number" || b.total <= rows.length,
  };
}

/** A run status answer into the snapshot the run step takes. */
function runSnapOf(runId: string, body: unknown): { snap: RunSnap; cursor?: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const view = b.view && typeof b.view === "object" ? b.view as Record<string, unknown> : null;
  const run = b.run && typeof b.run === "object" ? b.run as Record<string, unknown> : null;
  if (!view || typeof view.state !== "string") return null;
  const asks = Array.isArray(b.asks)
    ? (b.asks as unknown[]).map(a => {
      const title = a && typeof a === "object" && typeof (a as { title?: unknown }).title === "string" ? (a as { title: string }).title : undefined;
      return title ? { title } : {};
    })
    : [];
  const w = view.waiting && typeof view.waiting === "object" ? view.waiting as { reason?: unknown; until?: unknown } : undefined;
  return {
    snap: {
      runId: typeof run?.id === "string" ? run.id : runId,
      name: typeof run?.name === "string" ? run.name : "",
      state: view.state,
      asks,
      ...(w
        ? {
          waiting: {
            ...(typeof w.reason === "string" ? { reason: w.reason } : {}),
            ...(typeof w.until === "number" ? { until: w.until } : {}),
          },
        }
        : {}),
      ...(typeof run?.error === "string" ? { error: run.error } : {}),
    },
    ...(typeof b.cursor === "string" ? { cursor: b.cursor } : {}),
  };
}

// --- the cursor file: what the last arm saw ----------------------------------------

interface Persisted { v: 1; cursors: Record<string, string>; marks: Record<string, Record<string, string>>; runs: Record<string, string> }

function loadPersisted(path: string | null): Persisted {
  if (!path) return { v: 1, cursors: {}, marks: {}, runs: {} };
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<Persisted>;
    if (p && p.v === 1) {
      return {
        v: 1,
        cursors: p.cursors && typeof p.cursors === "object" ? p.cursors : {},
        marks: p.marks && typeof p.marks === "object" ? p.marks : {},
        runs: p.runs && typeof p.runs === "object" ? p.runs : {},
      };
    }
  } catch { /* a stale or foreign file reads as empty */ }
  return { v: 1, cursors: {}, marks: {}, runs: {} };
}

function savePersisted(path: string | null, state: Persisted) {
  if (!path) return;
  writeCursor(path, JSON.stringify(state));
}

// --- arguments ----------------------------------------------------------------------

const argv = process.argv.slice(2);
const threadId = flag(argv, "--thread");
const runId = flag(argv, "--run");
const fleet = argv.includes("--fleet");
const machineFlag = flag(argv, "--machine");
const machinesFlag = flag(argv, "--machines");
const lanePrefix = flag(argv, "--lane-prefix");
const until = flag(argv, "--until");
const base = (flag(argv, "--url") ?? process.env.LOOKOUT_URL ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const cursorPath = flag(argv, "--cursor");
const maxMs = Number(process.env.LOOKOUT_WATCH_MAX_MS ?? WATCH_MAX_MS);
const deadline = Date.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : WATCH_MAX_MS);

const fleetish = fleet || machineFlag !== null || machinesFlag !== null;
const selectors = [threadId, runId, fleetish ? "fleet" : null].filter(s => s !== null);
if (selectors.length === 0) usage("one of --thread, the fleet (--fleet, --machine, --machines) or --run is required");
if (selectors.length > 1) usage("pass one selector: --thread, the fleet, or --run");
if (until !== null && until !== "all-settled") usage("--until all-settled is the only exit mode");
if (lanePrefix !== null && !fleetish) usage("--lane-prefix goes with the fleet (--fleet, --machine, --machines)");
if (machineFlag !== null && machinesFlag !== null) usage("pass --machine <name> or --machines <list>, not both");
if (runId !== null && (machineFlag !== null || machinesFlag !== null)) usage("a workflow run is followed on this machine only; drop --machine and --machines");
if (lanePrefix === "") usage("--lane-prefix is empty");

// --- the fleet: one read per machine, lines as each answers --------------------------

interface Target { label: string; api: string; here: boolean }

async function resolveTargets(): Promise<{ targets: Target[]; notes: string[] }> {
  const local: Target = { label: "local", api: base, here: true };
  if (machineFlag === null && machinesFlag === null) return { targets: [local], notes: [] };
  const refs: string[] | "*" = machineFlag !== null
    ? [machineFlag]
    : machinesFlag === "*"
      ? "*"
      : (machinesFlag ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (refs !== "*" && refs.length === 0) usage("--machines names no machine");
  const list = await localGet(base, "/api/network/machines", 4000);
  const machines = list && typeof list === "object" && Array.isArray((list as { machines?: unknown }).machines)
    ? (list as { machines: Record<string, unknown>[] }).machines
    : null;
  if (machines === null) {
    // no list to resolve names against: the names go to the relay as given
    if (refs === "*") return { targets: [local], notes: ["machine list unreadable, watching this machine only"] };
    return { targets: refs.map(ref => ({ label: ref, api: machineBase(base, ref), here: false })), notes: [] };
  }
  const rows = machines.map(m => ({
    id: typeof m.id === "string" ? m.id : "",
    name: typeof m.name === "string" ? m.name : "",
    current: m.current === true,
    presence: typeof m.presence === "string" ? m.presence : "unknown",
  }));
  const watchable = (m: typeof rows[number]) => m.presence === "online" || m.presence === "degraded";
  const pick = (m: typeof rows[number]): Target =>
    m.current ? local : { label: m.name || m.id, api: machineBase(base, m.id), here: false };
  const notes: string[] = [];
  const picked: Target[] = [];
  const take = (ref: string) => {
    const hit = rows.find(m => m.id === ref || (m.name && m.name.toLowerCase() === ref.toLowerCase()));
    if (!hit) notes.push(`no machine ${ref} on this account, not watched`);
    else if (!hit.current && !watchable(hit)) notes.push(`${hit.name || hit.id} is ${hit.presence}, not watched`);
    else picked.push(pick(hit));
  };
  if (refs === "*") {
    for (const m of rows) {
      if (m.current) continue;
      if (watchable(m)) picked.push(pick(m));
      else notes.push(`${m.name || m.id} is ${m.presence}, not watched`);
    }
  } else for (const ref of [...new Set(refs)]) take(ref);
  const wanted = refs === "*" || picked.includes(local) ? [local, ...picked] : picked;
  const seen = new Set<string>();
  const targets = wanted.filter(t => {
    if (seen.has(t.api)) return false;
    seen.add(t.api);
    return true;
  });
  return { targets, notes };
}

async function watchFleet(): Promise<never> {
  const { targets, notes } = await resolveTargets();
  for (const n of notes) emit(`[lookout] ${n}`);
  if (!targets.length) usage("no machine to watch");
  const state = loadPersisted(cursorPath);
  const query = (waitS: number, since?: string) => {
    const p = new URLSearchParams({ limit: "200" });
    if (lanePrefix !== null) p.set("lanePrefix", lanePrefix);
    if (waitS > 0) p.set("wait", String(waitS));
    if (since) p.set("since", since);
    return `/api/lanes?${p.toString()}`;
  };
  const rt = targets.map(t => ({
    t,
    marks: new Map(Object.entries(state.marks[t.label] ?? {})),
    cursor: state.cursors[t.label] as string | undefined,
    rows: [] as FleetRow[],
    answering: true,
  }));
  const step = (r: (typeof rt)[number], body: unknown) => {
    const parsed = fleetRowsOf(body);
    if (!parsed) return null;
    r.cursor = parsed.cursor ?? r.cursor;
    const out = fleetStep(parsed.rows, r.marks, { machine: r.t.here ? undefined : r.t.label, complete: parsed.complete });
    r.marks = out.marks;
    r.rows = parsed.rows;
    state.cursors[r.t.label] = r.cursor ?? "";
    state.marks[r.t.label] = Object.fromEntries(out.marks);
    savePersisted(cursorPath, state);
    return out;
  };
  let first = true;
  for (;;) {
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) {
      emit(fleetDeadline(rt.flatMap(r => r.rows)));
      process.exit(0);
    }
    const waitS = first ? 0 : Math.max(1, Math.min(WAIT_S, Math.ceil(leftMs / 1000)));
    const roundStart = Date.now();
    const over = new AbortController();
    const inflight = rt.map((r, i) => {
      // a machine that stopped answering gets a short probe, not a held wait
      const holding = first || r.answering;
      return {
        i,
        p: read(r.t.api, query(holding ? waitS : 0, first ? undefined : r.cursor), {
          ...(holding ? { waitS } : { ms: 3000 }),
          signal: over.signal,
        }),
      };
    });
    while (inflight.length) {
      const { k, out: o } = await Promise.race(inflight.map((s, k) => s.p.then(out => ({ k, out }))));
      const subject = inflight.splice(k, 1)[0]!;
      const r = rt[subject.i]!;
      const name = r.t.here ? "this machine" : r.t.label;
      if (!o.ok) {
        if (r.answering) {
          r.answering = false;
          emit(`[lookout] ${name} stopped answering (${why(o)}), not watched until it answers again`);
        }
        continue;
      }
      const out = step(r, o.body);
      if (!out) {
        r.answering = false;
        emit(`[lookout] ${name} answered nothing readable, not watched this round`);
        continue;
      }
      r.answering = true;
      for (const line of out.lines) emit(line);
      if (out.answers > 0) {
        over.abort();
        process.exit(0);
      }
    }
    if (rt.every(r => !r.answering)) {
      emit("[lookout] fleet could not be watched (no machine answered).");
      process.exit(0);
    }
    if (rt.every(r => r.answering && r.rows.length === 0)) {
      emit(`[lookout] fleet: no chats to watch${lanePrefix !== null ? ` under lane prefix ${lanePrefix}` : ""}.`);
      process.exit(0);
    }
    if (rt.every(r => r.answering && r.rows.every(row => !rowOpen(row)))) {
      emit(fleetSummary(rt.flatMap(r => r.rows), rt.filter(r => r.answering).length));
      process.exit(0);
    }
    if (first) first = false;
    // a fleet with nothing moving answers at once: never spin on it
    else if (Date.now() - roundStart < 1000) await Bun.sleep(1000);
  }
}

// --- one workflow run ------------------------------------------------------------------

async function watchRun(): Promise<never> {
  const run = runId!;
  const state = loadPersisted(cursorPath);
  const runKey = `run:${run}`;
  let mark: string | null = state.runs[run] ?? null;
  let since: string | undefined = state.cursors[runKey];
  let snap: RunSnap | null = null;
  const path = (waitS: number) =>
    `/api/workflows/${encodeURIComponent(run)}${waitS > 0 || since ? `?${new URLSearchParams({ ...(waitS > 0 ? { wait: String(waitS) } : {}), ...(since ? { since } : {}) })}` : ""}`;
  // the first read waits for nothing: a run already ended or asking exits at once
  const first = await read(base, path(0));
  if (!first.ok) {
    emit(`[lookout] run ${run} could not be watched (${why(first)}).`);
    process.exit(0);
  }
  let parsed = runSnapOf(run, first.body);
  if (!parsed) {
    emit(`[lookout] run ${run} could not be read.`);
    process.exit(0);
  }
  for (;;) {
    since = parsed.cursor ?? since;
    const out = runStep(parsed.snap, mark);
    mark = out.mark;
    snap = parsed.snap;
    state.runs[run] = mark;
    if (since !== undefined) state.cursors[runKey] = since;
    savePersisted(cursorPath, state);
    if (out.line) emit(out.line);
    if (out.exit) process.exit(0);
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) {
      emit(runDeadline(snap ?? { runId: run, name: "", state: "unknown", asks: [] }));
      process.exit(0);
    }
    const waitS = Math.max(1, Math.min(WAIT_S, Math.ceil(leftMs / 1000)));
    const started = Date.now();
    const o = await read(base, path(waitS), { waitS });
    if (o.ok) {
      const next = runSnapOf(run, o.body);
      if (next) {
        parsed = next;
        // a healthy run's cursor moves with every step: a quiet pause keeps the reads out of a tight loop
        if (Date.now() - started < 1000) await Bun.sleep(1000);
        continue;
      }
    }
    // Lookout went away, or answered nothing readable: a pause, then the same wait again
    await Bun.sleep(1000);
  }
}

// --- one chat (the original mode) --------------------------------------------------------

if (runId !== null) await watchRun();
else if (fleetish) await watchFleet();
else {
  const thread = threadId!;
  const cursor = readCursor(cursorPath);

  const emitUnseen = (l: string | null): boolean => {
    if (l === null || !unseen(cursor, l)) return false;
    emit(l);
    writeCursor(cursorPath, l);
    return true;
  };

  const first = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(thread)}`, 2000), thread);
  // a chat waiting for its plan is told once and still watched: it goes on by itself
  if (first && rowWaitsForPlan(first)) emitUnseen(watchLine(thread, first));
  else if (emitUnseen(watchLine(thread, first))) process.exit(0);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
  try {
    const res = await fetch(`${base}/api/threads/${encodeURIComponent(thread)}/stream`, {
      headers: { [CLIENT_HEADER]: "mcp", accept: "text/event-stream", ...sessionHeaders(base) },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      emitUnseen(watchLine(thread, first) ?? `[lookout] ${thread} could not be watched (HTTP ${res.status}).`);
      process.exit(0);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      if (Date.now() >= deadline) {
        emitUnseen(deadlineLine(thread));
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
        const lane = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(thread)}`, 2000), thread);
        if (lane && rowWaitsForPlan(lane)) { emitUnseen(watchLine(thread, lane)); continue; }
        if (emitUnseen(watchLine(thread, lane))) { settled = true; break; }
      }
      if (settled) break;
    }
  } catch {
    if (Date.now() >= deadline) emitUnseen(deadlineLine(thread));
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}
