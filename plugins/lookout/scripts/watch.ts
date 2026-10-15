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
//   bun scripts/watch.ts --run <wfr_id> [--machine <name>]                   one workflow run (this machine, or that one)
//
// Every mode takes --url <lookout> (LOOKOUT_URL), --cursor <file> (what the
// last arm saw, so a re-arm prints no event twice) and --until all-settled
// (the only exit mode; it is the default).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLIENT_HEADER, HOLD_HEADER, localGet, machineBase, sessionHeaders } from "../src/local.js";
import {
  deadlineLine, decodeFleetCursor, fleetDeadline, fleetGone, fleetPageSettled, fleetStep, fleetSummary, fleetSummaryRows,
  offPageAnswers, offPageLines, offPageMarks, offPageNeedsDetail, runDeadline, runStep, rowWaitsForPlan, takeSseEvents, unseen,
  WATCH_MAX_MS, watchLine, type FleetRow, type LaneSnap, type RunSnap,
} from "../src/watch.js";

/** The server's longest hold for a lanes or run wait. */
const WAIT_S = 55;
/**
 * A read's budget past the server's hold. A busy app (hundreds of chats, a usage scan on its loop) has taken over
 * 20 s to answer a plain read; a shorter budget reads a slow machine as a gone one.
 */
const READ_SLACK_MS = 60_000;
/** Connection failures in a row (refused, no route, an HTTP error) before a machine is out of the batch; a timeout is not one. */
const DOWN_AFTER = 3;
/** The wait before the next try at a machine that failed `misses` times in a row: 2 s doubling to 30 s. */
const backoffMs = (misses: number) => Math.min(30_000, 1000 * 2 ** Math.min(misses, 5));
/** Omitted chats re-read by id in one round (a question, a quota wall, a crash resume). The rest stay unresolved. */
const DETAIL_CAP = 400;

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

/** `timedOutS`: no answer within the budget (the server is up, busy); `error`: the connection itself failed. */
type Read = { ok: true; body: unknown } | { ok: false; status: number; timedOutS?: number; error?: string; detail?: string };

async function read(api: string, path: string, o: { waitS?: number; signal?: AbortSignal } = {}): Promise<Read> {
  const waitS = o.waitS ?? 0;
  const ms = waitS * 1000 + READ_SLACK_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
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
    if (!res.ok) return { ok: false, status: res.status, detail: await res.text().then(t => t.slice(0, 300)).catch(() => "") };
    return { ok: true, body: await res.json().catch(() => null) };
  } catch (e) {
    if (timedOut) return { ok: false, status: 0, timedOutS: Math.round(ms / 1000) };
    const code = e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : null;
    return { ok: false, status: 0, error: code ?? (e instanceof Error ? e.message : "no connection") };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", abortWith);
  }
}

const why = (o: Read) =>
  o.ok ? "" : o.status ? `HTTP ${o.status}` : o.timedOutS ? `no answer in ${o.timedOutS} s` : `unreachable: ${o.error ?? "no connection"}`;

/** A 400 whose body is about the cursor ("since is not a cursor for these filters"): that server cannot read our stored one. */
const cursorRejected = (o: Read) => !o.ok && o.status === 400 && /cursor/i.test(o.detail ?? "");

/** A lanes answer into the rows the fleet step takes. */
function fleetRowsOf(body: unknown): { rows: FleetRow[]; cursor?: string; nextPage?: string; cursorReset?: boolean; total: number | null; complete: boolean } | null {
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
  const b = body as { cursor?: unknown; total?: unknown; nextPage?: unknown; cursorReset?: boolean };
  const total = typeof b.total === "number" ? b.total : null;
  return {
    rows,
    ...(typeof b.cursor === "string" ? { cursor: b.cursor } : {}),
    ...(typeof b.nextPage === "string" ? { nextPage: b.nextPage } : {}),
    ...(b.cursorReset ? { cursorReset: true } : {}),
    total,
    // no `total` is not proof the page is everyone: a cut that forgot the count must not read as settled
    complete: total !== null && total <= rows.length,
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
  const agents = Array.isArray(view.calls)
    ? view.calls.flatMap(c => {
      if (!c || typeof c !== "object") return [];
      const a = c as { key?: unknown; label?: unknown; state?: unknown; reason?: unknown; until?: unknown };
      if (typeof a.key !== "string" || typeof a.state !== "string") return [];
      return [{
        key: a.key,
        label: typeof a.label === "string" && a.label ? a.label : a.key,
        state: a.state,
        ...(typeof a.reason === "string" ? { reason: a.reason.slice(0, 200) } : {}),
        ...(typeof a.until === "number" ? { until: a.until } : {}),
      }];
    })
    : [];
  return {
    snap: {
      runId: typeof run?.id === "string" ? run.id : runId,
      name: typeof run?.name === "string" ? run.name : "",
      state: view.state,
      asks,
      agents,
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

interface Persisted { v: 2; scope: string; cursors: Record<string, string>; marks: Record<string, Record<string, string>>; runs: Record<string, string> }

function loadPersisted(path: string | null, scope: string): Persisted {
  if (!path) return { v: 2, scope, cursors: {}, marks: {}, runs: {} };
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<Persisted>;
    if (p && p.v === 2 && p.scope === scope) {
      return {
        v: 2, scope,
        cursors: p.cursors && typeof p.cursors === "object" ? p.cursors : {},
        marks: p.marks && typeof p.marks === "object" ? p.marks : {},
        runs: p.runs && typeof p.runs === "object" ? p.runs : {},
      };
    }
  } catch { /* a stale or foreign file reads as empty */ }
  return { v: 2, scope, cursors: {}, marks: {}, runs: {} };
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

// --machine names a fleet's one machine, or with --run the machine the run lives on
const fleetish = fleet || machinesFlag !== null || (machineFlag !== null && runId === null);
const selectors = [threadId, runId, fleetish ? "fleet" : null].filter(s => s !== null);
if (selectors.length === 0) usage("one of --thread, the fleet (--fleet, --machine, --machines) or --run is required");
if (selectors.length > 1) usage("pass one selector: --thread, the fleet, or --run");
if (until !== null && until !== "all-settled") usage("--until all-settled is the only exit mode");
if (lanePrefix !== null && !fleetish) usage("--lane-prefix goes with the fleet (--fleet, --machine, --machines)");
if (machineFlag !== null && machinesFlag !== null) usage("pass --machine <name> or --machines <list>, not both");
if (runId !== null && machinesFlag !== null) usage("a workflow run lives on one machine: pass --machine <name>, not --machines");
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
  const list = await localGet(base, "/api/network/machines", READ_SLACK_MS);
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
  const state = loadPersisted(cursorPath, JSON.stringify({ base, targets: targets.map(t => t.api), lanePrefix }));
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
    /** The server's page was the whole matched set. */
    pageComplete: true,
    /** Chats the page omitted, when the cursor named them and this round did not read their lanes. */
    off: null as Map<string, string> | null,
    /** ok: its last read answered; retrying: it failed and is tried again after a backoff; down: out of the batch. */
    state: "ok" as "ok" | "retrying" | "down",
    /** Answered at least once this arm: its rows are a read, not the empty start. */
    primed: false,
    misses: 0,
    /** Connection failures in a row (DOWN_AFTER). */
    fails: 0,
    /** The slow or unreadable line was printed for this streak of misses. */
    told: false,
    /** Wait before its next read: a backoff, or a pause after an instant answer. */
    pause: 0,
  }));
  const live = (r: (typeof rt)[number]) => r.state === "ok" && r.primed;
  // Opaque snapshots page without advancing the watch baseline, so an omitted question or plan wait cannot settle the batch.
  const hydrate = async (api: string, parsed: NonNullable<ReturnType<typeof fleetRowsOf>>) => {
    if (parsed.nextPage) {
      const rows = [...parsed.rows];
      let next = parsed.nextPage;
      const pages = new Set<string>();
      while (next && Date.now() < deadline && !pages.has(next)) {
        pages.add(next);
        const q = new URLSearchParams({ limit: "200", page: next });
        if (lanePrefix !== null) q.set("lanePrefix", lanePrefix);
        const got = await read(api, `/api/lanes?${q}`);
        const page = got.ok ? fleetRowsOf(got.body) : null;
        if (!page || page.cursorReset || page.cursor !== parsed.cursor) break;
        rows.push(...page.rows);
        next = page.nextPage ?? "";
      }
      return { rows, off: null, cursor: null, complete: !next && parsed.total !== null && rows.length >= parsed.total };
    }
    if (parsed.complete) return { rows: parsed.rows, off: null as Map<string, string> | null, cursor: null as Map<string, string> | null, complete: true };
    const cursor = parsed.cursor ? decodeFleetCursor(parsed.cursor) : null;
    const off0 = offPageMarks(parsed.rows, cursor);
    // a cursor shorter than `total` is not the matched set; the omitted chats cannot be judged from it
    if (!off0 || !cursor || (parsed.total !== null && cursor.size < parsed.total))
      return { rows: parsed.rows, off: null, cursor: null, complete: false };
    const need = offPageNeedsDetail(off0);
    const rank = (id: string) => {
      const mark = off0.get(id) ?? "";
      const state = mark.split(/[+~]/)[0] ?? mark;
      return state === "needs_input" || mark.includes("+asking") || state === "quota" ? 0 : 1;
    };
    const ids = [...need].sort((a, b) => rank(a) - rank(b)).slice(0, DETAIL_CAP);
    const extra: FleetRow[] = [];
    for (let i = 0; i < ids.length; i += 80) {
      const q = new URLSearchParams({ limit: "200", ids: ids.slice(i, i + 80).join(",") });
      if (lanePrefix !== null) q.set("lanePrefix", lanePrefix);
      const got = await read(api, `/api/lanes?${q}`);
      const page = got.ok ? fleetRowsOf(got.body) : null;
      if (!page) return { rows: [...parsed.rows, ...extra], off: offPageMarks([...parsed.rows, ...extra], cursor), cursor, complete: false };
      extra.push(...page.rows);
    }
    const rows = [...parsed.rows, ...extra];
    return { rows, off: offPageMarks(rows, cursor), cursor, complete: rows.length >= (parsed.total ?? Infinity) };
  };
  const step = async (r: (typeof rt)[number], body: unknown) => {
    const parsed = fleetRowsOf(body);
    if (!parsed) return null;
    const hydrated = await hydrate(r.t.api, parsed);
    const machine = r.t.here ? undefined : r.t.label;
    const before = r.marks;
    const out = fleetStep(hydrated.rows, before, { machine, complete: hydrated.complete });
    const answerExtra = hydrated.off ? offPageAnswers(before, hydrated.off, machine) : [];
    const lines = [
      ...out.lines,
      ...(hydrated.off ? offPageLines(before, hydrated.off, machine) : []),
      ...answerExtra,
      ...(hydrated.cursor ? fleetGone(before, hydrated.rows, hydrated.cursor, machine) : []),
    ];
    r.marks = new Map(out.marks);
    if (hydrated.off && hydrated.cursor) {
      for (const [id, mark] of hydrated.off) {
        const state = mark.split(/[+~]/)[0] ?? mark;
        // the cursor's `interrupted` does not say whether a resume is still pending; keep a mark the detail
        // read already made, and don't record the bare one or the next detail read would stay silent
        if (state === "interrupted") {
          const prev = before.get(id);
          if (prev?.startsWith("interrupted~")) r.marks.set(id, prev);
          continue;
        }
        r.marks.set(id, mark);
      }
      const seen = new Set([...hydrated.rows.map(x => x.threadId), ...hydrated.cursor.keys()]);
      for (const id of [...r.marks.keys()]) if (!seen.has(id)) r.marks.delete(id);
    }
    if (hydrated.complete || hydrated.cursor) r.cursor = parsed.cursor ?? r.cursor;
    r.rows = hydrated.rows;
    r.pageComplete = hydrated.complete;
    r.off = hydrated.off;
    state.cursors[r.t.label] = r.cursor ?? "";
    state.marks[r.t.label] = Object.fromEntries(r.marks);
    savePersisted(cursorPath, state);
    return { lines, answers: out.answers + answerExtra.length };
  };
  type Target = (typeof rt)[number];
  // each machine reads on its own clock, so a slow one never holds back another's lines
  const readOnce = async (r: Target) => {
    if (r.pause > 0) await Bun.sleep(r.pause);
    // only a machine that answered its last read holds a wait; the rest get a plain read
    const hold = live(r);
    const waitS = hold ? Math.max(1, Math.min(WAIT_S, Math.ceil((deadline - Date.now()) / 1000))) : 0;
    const started = Date.now();
    const out = await read(r.t.api, query(waitS, r.cursor), { waitS });
    return { r, out, ms: Date.now() - started };
  };
  const pending = new Map(rt.map(r => [r, readOnce(r)] as const));
  const timeUp = Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null);
  for (;;) {
    const got = await Promise.race([timeUp, ...pending.values()]);
    if (got === null) {
      const more = rt.flatMap(r => [...(r.off?.values() ?? [])]);
      if (rt.some(r => live(r) && !r.pageComplete && r.off === null))
        emit("[lookout] part of the fleet was cut off this read and could not be judged.");
      emit(fleetDeadline(rt.flatMap(r => r.rows), more));
      process.exit(0);
    }
    const { r, out: o, ms } = got;
    const name = r.t.here ? "this machine" : r.t.label;
    if (cursorRejected(o) && r.cursor) {
      // the stored cursor is unreadable to that server (an app update changed its format): drop it and
      // resync once from a fresh snapshot, never counting the 400 as the machine not answering
      r.cursor = undefined;
      delete state.cursors[r.t.label];
      savePersisted(cursorPath, state);
      pending.set(r, readOnce(r));
      continue;
    }
    const out = o.ok ? await step(r, o.body) : null;
    if (!out) {
      r.misses++;
      r.fails = o.ok || o.timedOutS ? 0 : r.fails + 1;
      r.pause = backoffMs(r.misses);
      if (r.state !== "down" && r.fails >= DOWN_AFTER) {
        r.state = "down";
        emit(`[lookout] ${name} stopped answering (${why(o)}), not watched until it answers again`);
      } else if (r.state !== "down") {
        r.state = "retrying";
        if (!r.told) emit(`[lookout] ${name} ${o.ok ? "answered nothing readable" : o.timedOutS ? `is slow (${why(o)})` : `did not answer (${why(o)})`}, still watched; trying again`);
      }
      r.told = true;
    } else {
      if (r.state === "down") emit(`[lookout] ${name} answers again, watched again`);
      Object.assign(r, { state: "ok", primed: true, misses: 0, fails: 0, told: false });
      for (const line of out.lines) emit(line);
      if (out.answers > 0) process.exit(0);
      // a fleet with nothing moving answers at once: never spin on it
      r.pause = ms < 1000 ? 1000 : 0;
    }
    if (rt.every(x => x.state === "down")) {
      emit("[lookout] fleet could not be watched (no machine answered).");
      process.exit(0);
    }
    if (rt.every(x => live(x) && x.rows.length === 0 && x.pageComplete)) {
      emit(`[lookout] fleet: no chats to watch${lanePrefix !== null ? ` under lane prefix ${lanePrefix}` : ""}.`);
      process.exit(0);
    }
    // a cut page of settled rows is not the batch: omitted queued, new, asking, parked, or interrupted chats still count.
    // fleetPageSettled stays false while any row waits for its plan, so a plan wait never exits.
    if (rt.every(x => live(x) && fleetPageSettled(x.rows, x.pageComplete, x.off) && !x.rows.some(rowWaitsForPlan))) {
      emit(fleetSummary(rt.flatMap(x => fleetSummaryRows(x.rows, x.pageComplete ? null : x.off)), rt.length));
      process.exit(0);
    }
    pending.set(r, readOnce(r));
  }
}

// --- one workflow run ------------------------------------------------------------------

async function watchRun(): Promise<never> {
  const run = runId!;
  // a run on another machine is read through this machine's relay surface, as a remote fleet is
  let api = base;
  let machine: string | undefined;
  if (machineFlag !== null) {
    const { targets, notes } = await resolveTargets();
    for (const n of notes) emit(`[lookout] ${n}`);
    const t = targets[0];
    if (!t) { emit(`[lookout] run ${run} could not be watched (${machineFlag} is not reachable).`); process.exit(0); }
    api = t.api;
    machine = t.here ? undefined : t.label;
  }
  const state = loadPersisted(cursorPath, JSON.stringify({ base: api, run }));
  const runKey = `run:${run}`;
  let mark: string | null = state.runs[run] ?? null;
  let since: string | undefined = state.cursors[runKey];
  let snap: RunSnap | null = null;
  const path = (waitS: number) =>
    `/api/workflows/${encodeURIComponent(run)}${waitS > 0 || since ? `?${new URLSearchParams({ ...(waitS > 0 ? { wait: String(waitS) } : {}), ...(since ? { since } : {}) })}` : ""}`;
  // the first read waits for nothing: a run already ended or asking exits at once
  let first = await read(api, path(0));
  for (let misses = 1; !first.ok && first.timedOutS && Date.now() < deadline; misses++) {
    await Bun.sleep(backoffMs(misses));
    first = await read(api, path(0));
  }
  if (!first.ok) {
    emit(`[lookout] ${machine ? `${machine}: ` : ""}run ${run} could not be watched (${why(first)}).`);
    process.exit(0);
  }
  let parsed = runSnapOf(run, first.body);
  if (!parsed) {
    emit(`[lookout] ${machine ? `${machine}: ` : ""}run ${run} could not be read.`);
    process.exit(0);
  }
  for (;;) {
    since = parsed.cursor ?? since;
    const out = runStep(parsed.snap, mark, machine);
    mark = out.mark;
    snap = parsed.snap;
    state.runs[run] = mark;
    if (since !== undefined) state.cursors[runKey] = since;
    savePersisted(cursorPath, state);
    if (out.line) emit(out.line);
    if (out.exit) process.exit(0);
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) {
      emit(runDeadline(snap ?? { runId: run, name: "", state: "unknown", asks: [] }, machine));
      process.exit(0);
    }
    const waitS = Math.max(1, Math.min(WAIT_S, Math.ceil(leftMs / 1000)));
    const started = Date.now();
    const o = await read(api, path(waitS), { waitS });
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

  const first = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(thread)}`, READ_SLACK_MS), thread);
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
        const lane = laneOf(await localGet(base, `/api/lanes?ids=${encodeURIComponent(thread)}`, READ_SLACK_MS), thread);
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
