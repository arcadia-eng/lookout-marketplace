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
//   bun scripts/watch.ts --follow [--lane-prefix p]... [--thread <id>]...    everything a lead follows, in one process
//   bun scripts/watch.ts --follow --forever                                  the plugin's monitor: what follow.json names
//   bun scripts/watch.ts --follow --add|--remove [--lane-prefix p]... [--thread <id>]... [--machines m]
//
// Every mode takes --url <lookout> (LOOKOUT_URL), --cursor <file> (what the
// last arm saw, so a re-arm prints no event twice) and --until all-settled
// (the only exit mode; it is the default).
//
// --follow never exits on a settle or a question: it prints the same lines
// for every filter until Monitor's cap, then one line saying so. Its cursor
// and marks default to follow.json in the plugin's data folder. --json prints
// each event as {content, meta}; --forever has no cap and ends with the
// Claude Code session (CLAUDE_PID), its parent, or a piped stdin closing.
// --forever with no filter is monitors/monitors.json's command: it follows
// follow.json's `follows`, which --add and --remove edit, and takes up a
// change within seconds.

import { fstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginDataDir } from "../src/data-dir.js";
import { CLIENT_HEADER, HOLD_HEADER, localGet, machineBase, sessionHeaders } from "../src/local.js";
import {
  deadlineLine, decodeFleetCursor, editFollows, fleetDeadline, fleetGoneEvents, fleetPageSettled, fleetStep, fleetSummary, fleetSummaryRows,
  followDeadline, followsLabel, followsOf, offPageAnswerEvents, offPageEvents, offPageMarks, offPageNeedsDetail, primeNews, rowMark,
  runDeadline, runStep, rowSettledOnOwnWork, rowWaitsForPlan, sameMark, takeSseEvents, unseen, WATCH_MAX_MS, watchLine,
  type FleetRow, type Follows, type LaneSnap, type RunSnap, type WatchEvent,
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
/** A forever watcher's one line for a machine that stopped answering: past an update's restart, which takes under a minute. */
const DOWN_TELL_MS = 2 * 60_000;
/** How often the monitor re-reads follow.json's `follows`, and checks that its session is still there. */
const FOLLOWS_POLL_MS = 3000;
const SESSION_POLL_MS = 10_000;

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  return argv[at + 1] ?? null;
}

/** Every value a repeatable flag was given. */
function flags(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[++i]!);
  return out;
}

function usage(message: string): never {
  console.error(`watch: ${message}`);
  process.exit(2);
}

/** One lane of GET /api/lanes, narrowed to what the lines say. */
function snapOf(row: Record<string, unknown>): LaneSnap | null {
  if (typeof row.state !== "string") return null;
  const asked = row.question && typeof row.question === "object" ? row.question as { title?: unknown; kind?: unknown } : undefined;
  const question = asked?.title;
  const reply = row.lastReply && typeof row.lastReply === "object" ? row.lastReply as { text?: unknown; truncated?: unknown; seq?: unknown } : null;
  const parked = parkedOf(row.parked);
  const openTodos = openTodosOf(row.openTodos);
  const landed = landedOf(row.landed);
  const shells = shellsOf(row.shells);
  const watches = watchesOf(row.watches);
  return {
    state: row.state,
    live: row.live === true,
    working: row.working === true,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof question === "string" ? { question } : {}),
    ...(asked?.kind === "handoff" ? { handoff: true } : {}),
    ...(typeof reply?.text === "string" ? { lastReply: reply.text, ...(reply.truncated === true ? { replyCut: true } : {}) } : {}),
    ...(typeof reply?.seq === "number" ? { replySeq: reply.seq } : {}),
    ...(typeof row.lastStopReason === "string" ? { lastStopReason: row.lastStopReason } : {}),
    ...(openTodos ? { openTodos } : {}),
    ...(shells ? { shells } : {}),
    ...(watches ? { watches } : {}),
    ...(parked ? { parked } : {}),
    ...(landed ? { landed } : {}),
    ...(typeof row.lane === "string" && row.lane ? { lane: row.lane } : {}),
    ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
  };
}

function laneOf(body: unknown, threadId: string): LaneSnap | null {
  if (!body || typeof body !== "object") return null;
  const lanes = (body as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanes)) return null;
  const row = lanes.find(l => !!l && typeof l === "object" && (l as { threadId?: string }).threadId === threadId) as Record<string, unknown> | undefined;
  return row ? snapOf(row) : null;
}

/** A lane's `landed` (the PR its landing notice named), narrowed. */
function landedOf(v: unknown): LaneSnap["landed"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const l = v as { pr?: unknown; merge?: unknown; at?: unknown };
  if (typeof l.pr !== "number") return undefined;
  return { pr: l.pr, ...(typeof l.merge === "string" ? { merge: l.merge } : {}), ...(typeof l.at === "number" ? { at: l.at } : {}) };
}

/** A lane's `parked` (whose plan it waits for, until when), narrowed. */
function parkedOf(v: unknown): LaneSnap["parked"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as { until?: unknown; model?: unknown };
  return { ...(typeof p.until === "number" ? { until: p.until } : {}), ...(typeof p.model === "string" ? { model: p.model } : {}) };
}

function shellsOf(v: unknown): LaneSnap["shells"] {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap(s => {
    if (!s || typeof s !== "object") return [];
    const o = s as { id?: unknown; command?: unknown };
    return [{ ...(typeof o.id === "number" || typeof o.id === "string" ? { id: o.id } : {}), ...(typeof o.command === "string" ? { command: o.command } : {}) }];
  });
  return out.length ? out : undefined;
}

function watchesOf(v: unknown): LaneSnap["watches"] {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap(s => {
    if (!s || typeof s !== "object") return [];
    const o = s as { id?: unknown; title?: unknown; until?: unknown };
    return [{
      ...(typeof o.id === "number" || typeof o.id === "string" ? { id: o.id } : {}),
      ...(typeof o.title === "string" ? { title: o.title } : {}),
      ...(typeof o.until === "number" ? { until: o.until } : {}),
    }];
  });
  return out.length ? out : undefined;
}

/** A lane's `openTodos` (the open count and the turn's last line), narrowed. */
function openTodosOf(v: unknown): LaneSnap["openTodos"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { count?: unknown; lastLine?: unknown };
  return typeof o.count === "number" ? { count: o.count, lastLine: typeof o.lastLine === "string" ? o.lastLine : "" } : undefined;
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
    const snap = snapOf(r);
    if (typeof r.threadId !== "string" || !snap) continue;
    const resetsAt = r.error && typeof r.error === "object" ? (r.error as { resetsAt?: unknown }).resetsAt : undefined;
    rows.push({
      ...snap,
      threadId: r.threadId,
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

function shortOf(v: unknown): Pick<RunSnap, "short"> {
  if (!v || typeof v !== "object") return {};
  const f = v as { agentsFailed?: unknown; phasesNotRun?: unknown };
  const failed = typeof f.agentsFailed === "number" ? f.agentsFailed : 0;
  const notRun = Array.isArray(f.phasesNotRun) ? f.phasesNotRun.filter((p): p is string => typeof p === "string") : [];
  return failed || notRun.length ? { short: { failed, notRun } } : {};
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
      ...shortOf(b.fellShort),
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

/**
 * What follow watchers saw, one file for all of them: per source (a machine and one filter) its server cursor and
 * marks, and per machine the last mark told of each chat, so a chat two filters match is told once. Each watcher
 * writes back only its own sources, over what the file holds then.
 */
interface FollowSource { cursor?: string; marks: Record<string, string>; at: number }
interface FollowFile { v: 3; sources: Record<string, FollowSource>; told: Record<string, Record<string, string>>; follows?: Follows }
const FOLLOW_KEEP_MS = 7 * 24 * 3600_000;

function loadFollow(path: string): FollowFile {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<FollowFile>;
    if (p?.v === 3 && p.sources && typeof p.sources === "object") {
      return { v: 3, sources: p.sources, told: p.told && typeof p.told === "object" ? p.told : {}, ...(p.follows ? { follows: followsOf(p.follows) } : {}) };
    }
  } catch { /* a missing, stale or foreign file reads as empty */ }
  return { v: 3, sources: {}, told: {} };
}

function saveFollow(path: string, mine: Record<string, FollowSource>, told: Record<string, Record<string, string>>, now = Date.now()) {
  const file = loadFollow(path);
  Object.assign(file.sources, mine);
  for (const [k, s] of Object.entries(file.sources)) if (now - (s.at ?? 0) > FOLLOW_KEEP_MS) delete file.sources[k];
  for (const [label, byId] of Object.entries(told)) file.told[label] = { ...file.told[label], ...byId };
  const live = new Set(Object.values(file.sources).flatMap(s => Object.keys(s.marks ?? {})));
  for (const byId of Object.values(file.told)) for (const id of Object.keys(byId)) if (!live.has(id)) delete byId[id];
  writeCursor(path, JSON.stringify(file));
}

// --- arguments ----------------------------------------------------------------------

const argv = process.argv.slice(2);
const follow = argv.includes("--follow");
const threadIds = flags(argv, "--thread");
const threadId = follow ? null : threadIds[0] ?? null;
const runId = flag(argv, "--run");
const fleet = argv.includes("--fleet");
const machineFlag = flag(argv, "--machine");
const machinesFlag = flag(argv, "--machines");
const lanePrefixes = flags(argv, "--lane-prefix");
const lanePrefix = follow ? null : lanePrefixes[0] ?? null;
const until = flag(argv, "--until");
const base = (flag(argv, "--url") ?? process.env.LOOKOUT_URL ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const cursorPath = flag(argv, "--cursor");
const followFile = cursorPath ?? join(pluginDataDir(), "follow.json");
const asJson = argv.includes("--json");
const forever = argv.includes("--forever");
const adding = argv.includes("--add");
const removing = argv.includes("--remove");
const editing = adding || removing;
/** The plugin's monitor: no filter of its own, it follows what follow.json names. */
const monitor = follow && forever && !editing && !lanePrefixes.length && !threadIds.length;
const maxMs = Number(process.env.LOOKOUT_WATCH_MAX_MS ?? WATCH_MAX_MS);
const deadline = forever ? Infinity : Date.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : WATCH_MAX_MS);

// --machine names a fleet's one machine, or with --run the machine the run lives on
const fleetish = !follow && (fleet || machinesFlag !== null || (machineFlag !== null && runId === null));
const selectors = [threadId, runId, fleetish ? "fleet" : null, follow ? "follow" : null].filter(s => s !== null);
if (selectors.length === 0) usage("one of --thread, the fleet (--fleet, --machine, --machines), --run or --follow is required");
if (selectors.length > 1) usage("pass one selector: --thread, the fleet, --run, or --follow");
if (until !== null && until !== "all-settled") usage("--until all-settled is the only exit mode");
if (lanePrefix !== null && !fleetish) usage("--lane-prefix goes with the fleet (--fleet, --machine, --machines) or --follow");
if (machineFlag !== null && machinesFlag !== null) usage("pass --machine <name> or --machines <list>, not both");
if (runId !== null && machinesFlag !== null) usage("a workflow run lives on one machine: pass --machine <name>, not --machines");
if (lanePrefixes.some(p => p === "")) usage("--lane-prefix is empty");
if (editing && !follow) usage("--add and --remove go with --follow");
if (adding && removing) usage("pass --add or --remove, not both");
if (editing && (forever || asJson)) usage("--add and --remove edit follow.json and exit: no --forever or --json");
if (editing && !lanePrefixes.length && !threadIds.length && machinesFlag === null && machineFlag === null)
  usage(`--${adding ? "add" : "remove"} needs a --lane-prefix, --thread or --machines`);
if (follow && !monitor && !editing && !lanePrefixes.length && !threadIds.length) usage("--follow needs at least one --lane-prefix or --thread, or --forever to follow what follow.json names");
if (!follow && (lanePrefixes.length > 1 || threadIds.length > 1)) usage("several --lane-prefix or --thread filters go with --follow");
if ((asJson || forever) && !follow) usage("--json and --forever go with --follow");

/** A note that is not a chat's event: a line for Monitor, stderr beside --json output. */
function note(line: string): void {
  if (asJson) console.error(line);
  else emit(line);
}

function emitEvent(e: WatchEvent): void {
  if (!asJson) return emit(e.line);
  const meta: Record<string, string> = { thread_id: e.threadId, state: e.kind };
  if (e.lane) meta.lane = e.lane;
  if (e.machine) meta.machine = e.machine;
  emit(JSON.stringify({ content: e.line, meta }));
}

// --- the fleet: one read per machine, lines as each answers --------------------------

interface Target { label: string; api: string; here: boolean }

/** Which machines a watch reads: `machine` one by name, `machines` a list or "*"; neither is this one. */
interface Reach { machine: string | null; machines: string | null }
const cliReach: Reach = { machine: machineFlag, machines: machinesFlag };
/** follow.json's `machines`: "*" or a list as --machines, a single name as --machine. */
const reachOf = (m?: string): Reach => !m ? { machine: null, machines: null } : m === "*" || m.includes(",") ? { machine: null, machines: m } : { machine: m, machines: null };

async function resolveTargets(reach: Reach = cliReach): Promise<{ targets: Target[]; notes: string[] }> {
  const local: Target = { label: "local", api: base, here: true };
  const { machine: machineFlag, machines: machinesFlag } = reach;
  if (machineFlag === null && machinesFlag === null) return { targets: [local], notes: [] };
  const refs: string[] | "*" = machineFlag !== null
    ? [machineFlag]
    : machinesFlag === "*"
      ? "*"
      : (machinesFlag ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (refs !== "*" && refs.length === 0) {
    if (monitor) return { targets: [local], notes: [] };
    usage("--machines names no machine");
  }
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

/** What one source reads: chats under a lane prefix, named chats, or (null) every chat on the machine. */
type Filter = { lanePrefix: string } | { ids: string[] } | null;
const filterKey = (f: Filter) => f === null ? "all" : "lanePrefix" in f ? `prefix:${f.lanePrefix}` : `ids:${[...f.ids].sort().join(",")}`;
function withFilter(p: URLSearchParams, f: Filter): URLSearchParams {
  if (f && "lanePrefix" in f) p.set("lanePrefix", f.lanePrefix);
  else if (f) p.set("ids", f.ids.join(","));
  return p;
}

type Parsed = NonNullable<ReturnType<typeof fleetRowsOf>>;

// Opaque snapshots page without advancing the watch baseline, so an omitted question or plan wait cannot settle the batch.
async function hydrate(api: string, parsed: Parsed, f: Filter) {
  if (parsed.nextPage) {
    const rows = [...parsed.rows];
    let next = parsed.nextPage;
    const pages = new Set<string>();
    while (next && Date.now() < deadline && !pages.has(next)) {
      pages.add(next);
      const got = await read(api, `/api/lanes?${withFilter(new URLSearchParams({ limit: "200", page: next }), f)}`);
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
    const q = withFilter(new URLSearchParams({ limit: "200" }), f);
    q.set("ids", ids.slice(i, i + 80).join(","));
    const got = await read(api, `/api/lanes?${q}`);
    const page = got.ok ? fleetRowsOf(got.body) : null;
    if (!page) return { rows: [...parsed.rows, ...extra], off: offPageMarks([...parsed.rows, ...extra], cursor), cursor, complete: false };
    extra.push(...page.rows);
  }
  const rows = [...parsed.rows, ...extra];
  return { rows, off: offPageMarks(rows, cursor), cursor, complete: rows.length >= (parsed.total ?? Infinity) };
}

/**
 * Turns about to be told whose reply a listing cut to its head and tail, read again by id: that read carries the
 * whole reply (to the server's shown limit), so a decision in the middle of a long report still reaches the line.
 */
async function wholeReplies(api: string, rows: FleetRow[], before: Map<string, string>): Promise<FleetRow[]> {
  const ids = rows.filter(r => r.replyCut && !r.live && !sameMark(before.get(r.threadId), rowMark(r))).map(r => r.threadId);
  if (!ids.length) return rows;
  const whole = new Map<string, Pick<FleetRow, "lastReply" | "replySeq">>();
  for (let i = 0; i < ids.length; i += 40) {
    const got = await read(api, `/api/lanes?${new URLSearchParams({ limit: "200", ids: ids.slice(i, i + 40).join(",") })}`);
    for (const r of (got.ok ? fleetRowsOf(got.body)?.rows : null) ?? [])
      if (!r.replyCut && r.lastReply) whole.set(r.threadId, { lastReply: r.lastReply, ...(r.replySeq !== undefined ? { replySeq: r.replySeq } : {}) });
  }
  return rows.map(r => whole.has(r.threadId) ? { ...r, ...whole.get(r.threadId)!, replyCut: false } : r);
}

interface Spec { lanePrefixes: string[]; threadIds: string[]; reach: Reach }
const cliSpec: Spec = { lanePrefixes, threadIds, reach: cliReach };
/** What the monitor said of its machines, so a watch it starts again says each once. */
const monitorNotes = new Set<string>();

/** Returns only when `stop` aborts (the monitor's follows changed); every other end exits the process. */
async function watchSources(spec: Spec = cliSpec, stop?: AbortSignal): Promise<void> {
  const { targets, notes } = await resolveTargets(spec.reach);
  if (stop?.aborted) return;
  for (const n of notes) if (!monitor || !monitorNotes.has(n)) { monitorNotes.add(n); note(`[lookout] ${n}`); }
  if (!targets.length) {
    if (!monitor) usage("no machine to watch");
    await Promise.race([Bun.sleep(60_000), new Promise(res => stop?.addEventListener("abort", res, { once: true }))]);
    return;
  }
  const prefixes = [...new Set(spec.lanePrefixes)];
  const ids = [...new Set(spec.threadIds)];
  const filters: Filter[] = follow
    ? [...prefixes.map(p => ({ lanePrefix: p })), ...(ids.length ? [{ ids }] : [])]
    : [lanePrefix !== null ? { lanePrefix } : null];
  const desc = followsLabel({ lanePrefixes: prefixes, threads: ids });
  const followPath = follow ? followFile : null;
  const batch = follow ? null : loadPersisted(cursorPath, JSON.stringify({ base, targets: targets.map(t => t.api), lanePrefix }));
  const file = followPath ? loadFollow(followPath) : null;
  // per machine, the last mark any of this watcher's sources processed of each chat
  const told: Record<string, Record<string, string>> = {};
  for (const [label, byId] of Object.entries(file?.told ?? {})) told[label] = { ...byId };
  const query = (f: Filter, waitS: number, since?: string) => {
    const p = withFilter(new URLSearchParams({ limit: "200" }), f);
    if (waitS > 0) p.set("wait", String(waitS));
    if (since) p.set("since", since);
    return `/api/lanes?${p.toString()}`;
  };
  const rt = targets.flatMap(t => filters.map(f => {
    const key = `${t.api} ${filterKey(f)}`;
    const kept = file?.sources[key];
    return {
      t, f, key,
      marks: new Map(Object.entries(batch ? batch.marks[t.label] ?? {} : kept?.marks ?? {})),
      cursor: (batch ? batch.cursors[t.label] : kept?.cursor) || undefined,
      /** A follow filter this file has no record of: its first read tells news, not history. */
      fresh: !!file && !kept,
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
      /** When this streak of failed reads began (a forever watcher tells one line past DOWN_TELL_MS). */
      failingSince: 0,
    };
  }));
  /** Machines a forever watcher has told are not answering, so several filters on one say it once. */
  const downTold = new Set<string>();
  type Source = (typeof rt)[number];
  const live = (r: Source) => r.state === "ok" && r.primed;
  const save = (r: Source) => {
    if (batch) {
      batch.cursors[r.t.label] = r.cursor ?? "";
      batch.marks[r.t.label] = Object.fromEntries(r.marks);
      return savePersisted(cursorPath, batch);
    }
    const mine = rt.filter(s => s.primed || !s.fresh).map(s => [s.key, { ...(s.cursor ? { cursor: s.cursor } : {}), marks: Object.fromEntries(s.marks), at: Date.now() }] as const);
    saveFollow(followPath!, Object.fromEntries(mine), told);
  };
  const step = async (r: Source, body: unknown) => {
    const parsed = fleetRowsOf(body);
    if (!parsed) return null;
    const hydrated = await hydrate(r.t.api, parsed, r.f);
    const machine = r.t.here ? undefined : r.t.label;
    let before = r.marks;
    if (r.fresh && !r.primed) {
      const now = Date.now();
      before = new Map([...hydrated.rows.filter(x => !primeNews(x, now)).map(x => [x.threadId, rowMark(x)] as const), ...(hydrated.off ?? [])]);
    }
    const whole = await wholeReplies(r.t.api, hydrated.rows, before);
    // a watch the monitor replaced must not write marks over its successor's
    if (stop?.aborted) return null;
    const out = fleetStep(whole, before, { machine, complete: hydrated.complete });
    const answerExtra = hydrated.off ? offPageAnswerEvents(before, hydrated.off, machine) : [];
    let events = [
      ...out.events,
      ...(hydrated.off ? offPageEvents(before, hydrated.off, machine) : []),
      ...answerExtra,
      ...(hydrated.cursor ? fleetGoneEvents(before, hydrated.rows, hydrated.cursor, machine) : []),
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
    if (follow) {
      // a chat two filters match is told by the first that reads its new mark
      const byId = (told[r.t.label] ??= {});
      const markOf = (e: WatchEvent) => e.kind === "gone" ? "gone" : r.marks.get(e.threadId) ?? e.kind;
      events = events.filter(e => byId[e.threadId] !== markOf(e));
      for (const [id, mark] of r.marks) if (before.get(id) !== mark) byId[id] = mark;
      for (const e of events) byId[e.threadId] = markOf(e);
    }
    if (hydrated.complete || hydrated.cursor) r.cursor = parsed.cursor ?? r.cursor;
    r.rows = hydrated.rows;
    r.pageComplete = hydrated.complete;
    r.off = hydrated.off;
    r.primed = true;
    save(r);
    return { events, answers: out.answers + answerExtra.length };
  };
  // each machine reads on its own clock, so a slow one never holds back another's lines
  const readOnce = async (r: Source) => {
    if (r.pause > 0) await Bun.sleep(r.pause);
    // only a machine that answered its last read holds a wait; the rest get a plain read
    const hold = live(r);
    const waitS = hold ? Math.max(1, Math.min(WAIT_S, Math.ceil((deadline - Date.now()) / 1000))) : 0;
    const started = Date.now();
    const out = await read(r.t.api, query(r.f, waitS, r.cursor), { waitS, signal: stop });
    return { r, out, ms: Date.now() - started };
  };
  const pending = new Map(rt.map(r => [r, readOnce(r)] as const));
  const timeUp = forever ? new Promise<null>(() => {}) : Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null);
  const halted = new Promise<"halt">(res => stop?.addEventListener("abort", () => res("halt"), { once: true }));
  let quietTold = false;
  for (;;) {
    const got = await Promise.race([timeUp, halted, ...pending.values()]);
    if (got === "halt") return;
    if (got === null) {
      if (follow) {
        emit(followDeadline(rt.flatMap(r => r.rows), desc));
        process.exit(0);
      }
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
      save(r);
      pending.set(r, readOnce(r));
      continue;
    }
    const wasDown = r.state === "down";
    const out = o.ok ? await step(r, o.body) : null;
    if (stop?.aborted) return;
    if (!out) {
      r.misses++;
      r.fails = o.ok || o.timedOutS ? 0 : r.fails + 1;
      r.pause = backoffMs(r.misses);
      r.failingSince ||= Date.now();
      if (forever) {
        // every line wakes the session: an app restart says nothing, a longer outage one line per machine
        if (r.fails >= DOWN_AFTER) r.state = "down";
        else if (r.state !== "down") r.state = "retrying";
        if (!downTold.has(r.t.api) && Date.now() - r.failingSince >= DOWN_TELL_MS) {
          downTold.add(r.t.api);
          note(`[lookout] ${name} has not answered for ${Math.round((Date.now() - r.failingSince) / 60_000)} min (${why(o)}); still following and retrying, nothing to arm again`);
        }
      } else if (r.state !== "down" && r.fails >= DOWN_AFTER) {
        r.state = "down";
        note(`[lookout] ${name} stopped answering (${why(o)}), not watched until it answers again`);
      } else if (r.state !== "down") {
        r.state = "retrying";
        if (!r.told) note(`[lookout] ${name} ${o.ok ? "answered nothing readable" : o.timedOutS ? `is slow (${why(o)})` : `did not answer (${why(o)})`}, still watched; trying again`);
      }
      r.told = true;
    } else {
      if (wasDown && !forever) note(`[lookout] ${name} answers again, watched again`);
      downTold.delete(r.t.api);
      Object.assign(r, { state: "ok", misses: 0, fails: 0, told: false, failingSince: 0 });
      for (const e of out.events) emitEvent(e);
      if (!follow && out.answers > 0) process.exit(0);
      // a fleet with nothing moving answers at once: never spin on it
      r.pause = ms < 1000 ? 1000 : 0;
    }
    if (follow) {
      // a follow watcher outlives a quiet fleet and an app restart: it never exits before its cap
      if (!quietTold && !forever && rt.every(x => live(x) && x.rows.length === 0 && x.pageComplete)) {
        note(`[lookout] follow: nothing matches ${desc} yet; still following`);
        quietTold = true;
      }
      pending.set(r, readOnce(r));
      continue;
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

// --- the monitor: what follow.json names, for the whole session ----------------------------

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
};

/**
 * A forever watcher ends with whoever reads it. A plugin monitor's stdin is /dev/null (at its end from the start) and
 * Claude Code killed hard leaves it running under a live shell, so the session's own pid is what says it went.
 */
function endWithSession(): void {
  let piped = false;
  try { const st = fstatSync(0); piped = st.isFIFO() || st.isSocket(); } catch { /* no stdin at all */ }
  if (piped) void (async () => { for await (const _ of Bun.stdin.stream()) { /* nothing is read from it */ } process.exit(0); })();
  const parent = process.ppid;
  const claude = Number(process.env.CLAUDE_PID) || 0;
  setInterval(() => { if (process.ppid !== parent || (claude > 1 && !alive(claude))) process.exit(0); }, SESSION_POLL_MS);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => process.exit(0));
}

const monitorsDir = () => join(dirname(followFile), "monitors");

/** Running monitors on this follow file, so an edit can say whether one takes it up. */
function liveMonitors(): number[] {
  let names: string[] = [];
  try { names = readdirSync(monitorsDir()); } catch { return []; }
  return names.flatMap(n => {
    const pid = Number(n.replace(/\.json$/, ""));
    if (!Number.isInteger(pid) || pid <= 1) return [];
    if (alive(pid)) return [pid];
    rmSync(join(monitorsDir(), n), { force: true });
    return [];
  });
}

const noFollows = (): Follows => followsOf(null);
const followsNow = () => JSON.stringify(loadFollow(followFile).follows ?? noFollows());

async function followFromFile(): Promise<never> {
  const mine = join(monitorsDir(), `${process.pid}.json`);
  mkdirSync(monitorsDir(), { recursive: true });
  writeFileSync(mine, JSON.stringify({ pid: process.pid, claudePid: Number(process.env.CLAUDE_PID) || null, startedAt: Date.now() }));
  process.on("exit", () => rmSync(mine, { force: true }));
  for (;;) {
    const key = followsNow();
    const set = followsOf(JSON.parse(key));
    const ctrl = new AbortController();
    const poll = setInterval(() => { if (followsNow() !== key) ctrl.abort(); }, FOLLOWS_POLL_MS);
    if (set.lanePrefixes.length || set.threads.length) {
      await watchSources({ lanePrefixes: set.lanePrefixes, threadIds: set.threads, reach: reachOf(set.machines) }, ctrl.signal)
        .catch(e => console.error(`watch: ${e instanceof Error ? e.message : String(e)}`));
      // a watch that ended by itself is a fault, not news: again after a pause, with nothing printed
      if (!ctrl.signal.aborted) await Promise.race([Bun.sleep(30_000), new Promise(res => ctrl.signal.addEventListener("abort", res, { once: true }))]);
    } else await new Promise(res => ctrl.signal.addEventListener("abort", res, { once: true }));
    clearInterval(poll);
  }
}

function editFollowFile(): never {
  const reach = machinesFlag ?? machineFlag;
  const edit = { remove: removing, lanePrefixes, threads: threadIds, ...(reach !== null ? { machines: reach } : {}) };
  let want: Follows | null = null;
  // the running watchers rewrite this file after each read: write until a read back keeps the edit
  for (let i = 0; i < 5; i++) {
    const file = loadFollow(followFile);
    if (want && JSON.stringify(file.follows ?? noFollows()) === JSON.stringify(want)) break;
    want = editFollows(file.follows ?? noFollows(), edit);
    writeCursor(followFile, JSON.stringify({ ...file, follows: want }));
    Bun.sleepSync(150);
  }
  emit(`[lookout] follow.json follows ${followsLabel(want!)}.`);
  const mons = liveMonitors();
  if (mons.length) emit(`[lookout] the monitor (pid ${mons.join(", ")}) takes it up within ${FOLLOWS_POLL_MS / 1000} s; nothing to arm.`);
  else emit(`[lookout] no monitor runs on this file (plugin monitors start only in interactive sessions): arm Monitor with persistent true and no timeout_ms on: sh "${join(import.meta.dir, "bun.sh")}" "${import.meta.path}" --follow --forever --cursor "${followFile}"`);
  process.exit(0);
}

// --- one chat (the original mode) --------------------------------------------------------

if (forever) endWithSession();
if (editing) editFollowFile();
else if (runId !== null) await watchRun();
else if (monitor) await followFromFile();
else if (fleetish || follow) await watchSources();
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
  if (first && (rowWaitsForPlan(first) || rowSettledOnOwnWork(first))) emitUnseen(watchLine(thread, first));
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
        if (lane && (rowWaitsForPlan(lane) || rowSettledOnOwnWork(lane))) { emitUnseen(watchLine(thread, lane)); continue; }
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
