// The Monitor watcher: one line when a Lookout chat settles or needs a
// person, nothing while it is working. SSE frames are split here so the
// script can be tested without a server, and the fleet and run steps turn a
// snapshot plus the marks of the previous read into the lines a batch
// watcher prints: one per settle, needs_input, quota wall (with the reset)
// or workflow ask, never the same event twice across a cursor. A chat that
// waits out its plan (state parked) gets one line and stays watched. A page
// cut at the lanes limit is not the batch: omitted chats still count.

export interface SseEvent { data: string }

/** Consume complete SSE events (separated by a blank line). `rest` is the tail. */
export function takeSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  for (;;) {
    const at = rest.indexOf("\n\n");
    if (at < 0) break;
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);
    const data = block.split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(5).trimStart())
      .join("\n");
    if (data) events.push({ data });
  }
  return { events, rest };
}

export interface LaneSnap {
  state: string;
  live: boolean;
  working: boolean;
  title?: string;
  question?: string;
  lastReply?: string;
  /** How the last turn ended (the lane's `lastStopReason`); an `incomplete` state's which limit. */
  lastStopReason?: string;
  /** The lane's `openTodos`: its last turn ended with open todos while nothing of its own ran. */
  openTodos?: { count: number; lastLine: string };
  /** Its own background commands and watches still running (the lane's `shells`/`watches` rows). */
  shells?: readonly unknown[];
  watches?: readonly unknown[];
  /** State parked: the model whose plan it waits for, and the reset (the lane's `parked`). */
  parked?: { until?: number; model?: string };
  /** The lane's `lastReply.truncated`: `lastReply` is the head and tail excerpt, a read by id has the whole text. */
  replyCut?: boolean;
  /** The lane's `landed`: its newest turn was the landing notice of a ship it queued (the report stays `lastReply`). */
  landed?: { pr: number; merge?: string; at?: number };
  /** The lane key and the chat's last activity (the lane's `lane` and `updatedAt`). */
  lane?: string;
  updatedAt?: number;
}

/** States that still need the watcher to stay open. */
const OPEN = new Set(["running", "background", "compacting", "restoring"]);

/** Every state a chat moves through on its way to an answer (a fleet adds new and queued). */
const IN_FLIGHT = new Set(["new", "running", "queued", "background", "compacting", "restoring"]);

/** The states a batch settles into, display order; anything else a lane may one day say is still watched, not told. */
const SETTLED_ORDER = ["done", "open-todos", "incomplete", "stopped", "quota", "failed", "interrupted"] as const;
const SETTLED = new Set<string>(SETTLED_ORDER);

// The wire keeps `done` on such a lane; src/ontology/product/open-todos.ts (mirrored here)
// is the derivation every surface shares.
const OPEN_TODOS = "open-todos";
const laneOpenTodos = (l: Pick<LaneSnap, "state" | "openTodos" | "shells" | "watches">): LaneSnap["openTodos"] =>
  l.state === "done" && !l.shells?.length && !l.watches?.length ? l.openTodos : undefined;
const openTodosLine = (n: number): string => `stopped with ${n} open ${n === 1 ? "todo" : "todos"}, nothing running`;
/** endedHow (src/server/lanes.ts) on the stop reasons that settle a lane `incomplete`. */
const incompleteHow = (stop: string | undefined): string => {
  const s = stop ?? "limit";
  return s === "max_rounds" ? "hit the round limit"
    : s === "length" ? "hit the output limit"
    : s === "context_exhausted" ? "ran out of context"
    : `ended (${s})`;
};

export interface WatchExtras {
  /** The chat's workflow runs waiting on a person (the lane's `asking`). */
  asking?: number;
  /** A crash resume that goes on by itself (the lane's `crashResume`). */
  crashResume?: string;
  /** When the spent plan resets (the lane error's `resetsAt`). */
  resetsAt?: number;
  /** The machine the chat lives on, when it is not this one. */
  machine?: string;
}

const isoMinute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const errTail = (text?: string, chars = 240) => {
  const t = text?.trim();
  return t ? `: ${t.slice(0, chars)}` : "";
};

/** The first line's share of a settle line, and the closing paragraph's (whole sentences). */
export const GIST_FIRST = 200;
export const GIST_CLOSING = 600;
/** The lanes excerpt's cut (src/server/lanes.ts excerpt): head, this marker, tail. */
const OMITTED = /\n…\[\d+ chars omitted\]…\n/;
/** The convention the orchestrate skill gives work orders: a closing paragraph the lead must answer. */
const DECISION = /^[*_#>\s]*decision for the lead\s*:\s*(?:\*\*|__)?\s*/i;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Whole sentences from the start of `text` within `max` characters; a first sentence longer than that is cut at a word. */
export function sentencesWithin(text: string, max: number): string {
  const t = flat(text);
  if (t.length <= max) return t;
  const ends = [...t.matchAll(/[.!?](?=\s|$)/g)].map(m => m.index! + 1).filter(i => i <= max);
  if (ends.length) return t.slice(0, ends.at(-1));
  const space = t.lastIndexOf(" ", max - 1);
  return `${t.slice(0, space > max / 2 ? space : max - 1)}…`;
}

export interface ReplyGist {
  /** The reply's first line. */
  first: string;
  /** Its closing paragraph; the same text as `first` for a reply of one paragraph. */
  closing: string;
  /** A paragraph near the end that starts "Decision for the lead:", without that label. */
  decision?: string;
}

/** What a settle line carries of a reply: its first line and its closing paragraph, or the decision it leaves the lead. */
export function replyGist(reply?: string): ReplyGist | null {
  const t = reply?.trim();
  if (!t) return null;
  const cut = OMITTED.exec(t);
  const head = cut ? t.slice(0, cut.index) : t;
  const paras = (cut ? t.slice(cut.index + cut[0].length) : t).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  // the excerpt's tail starts inside a paragraph: drop the sentence it cut
  const at = cut && paras.length ? paras[0]!.search(/[.!?]\s/) : -1;
  if (at >= 0) paras[0] = paras[0]!.slice(at + 2).trim();
  const firstLine = (head.split("\n").map(l => l.trim()).find(Boolean) ?? "").replace(/^[#>*\s]+/, "").replace(/\*\*/g, "");
  const first = sentencesWithin(firstLine, GIST_FIRST);
  const closing = sentencesWithin(paras.at(-1) || firstLine, GIST_CLOSING);
  const asked = [...paras].reverse().find(p => DECISION.test(p));
  return { first, closing, ...(asked ? { decision: sentencesWithin(asked.replace(DECISION, ""), GIST_CLOSING) } : {}) };
}

/** `: <first line> … <closing paragraph>`, or the one of them a short reply has. */
function gistTail(reply?: string): string {
  const g = replyGist(reply);
  if (!g) return "";
  if (!g.first || g.closing.startsWith(g.first.replace(/…$/, ""))) return `: ${g.closing}`;
  return `: ${g.first} … ${g.closing}`;
}

/** What a watch line says, for a reader that routes on it (the channel's meta `state`). */
export type WatchKind =
  | "parked" | "needs_input" | "workflow_asks" | "quota" | "open-todos" | "incomplete" | "asks" | "landed"
  | "done" | "failed" | "stopped" | "interrupted" | "gone" | (string & {});

export interface WatchEvent { threadId: string; line: string; kind: WatchKind; machine?: string; lane?: string }

/**
 * A line for Monitor, or null to keep waiting. `needs_input` and a workflow
 * ask are lines: someone has to answer, and waiting further would hide that.
 * A quota wall names when the plan resets; a chat that waits for its plan
 * says whose and until when (the watcher prints it and keeps watching:
 * rowWaitsForPlan); every other settle carries the reply's first line and its
 * closing paragraph. A done that closes on "Decision for the lead:" is an
 * `asks` line, and a done whose newest turn was its landing notice says the PR.
 */
export function watchEvent(threadId: string, lane: LaneSnap | null, x: WatchExtras = {}): Omit<WatchEvent, "threadId"> | null {
  if (!lane) return null;
  const title = lane.title?.trim() || threadId;
  const at = `${x.machine ? `${x.machine}: ` : ""}${title} (${threadId})`;
  const say = (kind: WatchKind, line: string) => ({ kind, line: `[lookout] ${at} ${line}`, ...(x.machine ? { machine: x.machine } : {}), ...(lane.lane ? { lane: lane.lane } : {}) });
  if (lane.state === "parked" && !lane.live) {
    const plan = lane.parked?.model ? `${lane.parked.model}'s plan` : "its plan";
    return say("parked", `waiting for ${plan}${lane.parked?.until ? ` until ${isoMinute(lane.parked.until)}` : ""}`);
  }
  if (lane.state === "needs_input") {
    const q = lane.question?.trim();
    return say("needs_input", q ? `needs input: ${q}` : "needs input");
  }
  if ((x.asking ?? 0) > 0) return say("workflow_asks", `workflow asks (${x.asking} open)`);
  if (lane.working || lane.live || OPEN.has(lane.state)) return null;
  if (lane.state === "quota") {
    const resets = x.resetsAt ? ` (resets ${isoMinute(x.resetsAt)})` : "";
    return say("quota", `quota${resets}${gistTail(lane.lastReply)}`);
  }
  const todos = laneOpenTodos(lane);
  if (todos) return say(OPEN_TODOS, `${openTodosLine(todos.count)}${gistTail(todos.lastLine || lane.lastReply)}`);
  if (lane.state === "incomplete") return say("incomplete", `incomplete: ${incompleteHow(lane.lastStopReason)}${gistTail(lane.lastReply)}`);
  if (lane.state === "done" && lane.landed) return say("landed", `landed #${lane.landed.pr}`);
  const decision = lane.state === "done" ? replyGist(lane.lastReply)?.decision : undefined;
  if (decision) return say("asks", `done, asks: ${decision}`);
  return say(lane.state, `${lane.state}${gistTail(lane.lastReply)}`);
}

export function watchLine(threadId: string, lane: LaneSnap | null, x: WatchExtras = {}): string | null {
  return watchEvent(threadId, lane, x)?.line ?? null;
}

/** A chat as the fleet step keeps it: a lane plus what hides inside its state. */
export interface FleetRow extends LaneSnap {
  threadId: string;
  asking?: number;
  crashResume?: string;
  resetsAt?: number;
}

/** A chat that waits for its plan's reset and goes on by itself: told once, then watched, never a reason to exit. */
export const rowWaitsForPlan = (row: LaneSnap): boolean => row.state === "parked" && !row.live;

/** A chat blocked on a person: its own question, or a workflow run of it asking. */
export const rowWaitsOnPerson = (row: FleetRow): boolean => row.state === "needs_input" || (row.asking ?? 0) > 0;

/** A chat the batch still waits on: in flight, or blocked on a person (not settled). */
export function rowOpen(row: FleetRow): boolean {
  if (rowWaitsOnPerson(row)) return true;
  if (row.working || row.live || IN_FLIGHT.has(row.state)) return true;
  if (row.state === "interrupted" && (row.crashResume === "pending" || row.crashResume === "resumed")) return true;
  return !SETTLED.has(row.state);
}

/** The mark a fleet read keeps of a chat: its state, a workflow ask, an open-todos settle, a landing, a crash resume. */
export function rowMark(row: FleetRow): string {
  const landed = row.state === "done" && row.landed ? `+landed${row.landed.pr}` : "";
  return `${row.state}${(row.asking ?? 0) > 0 ? "+asking" : ""}${laneOpenTodos(row) ? "+todos" : ""}${landed}${row.crashResume ? `~${row.crashResume}` : ""}`;
}

/** A mark back to whether the batch still waits on that chat. */
export function markOpen(mark: string): boolean {
  const state = mark.split(/[+~]/)[0] ?? mark;
  if (state === "needs_input" || mark.includes("+asking")) return true;
  if (IN_FLIGHT.has(state)) return true;
  if (state === "interrupted" && (mark.includes("~pending") || mark.includes("~resumed"))) return true;
  return !SETTLED.has(state);
}

export interface FleetStep {
  /** One line per event since the previous read, in the read's row order. */
  lines: string[];
  /** The same lines with the chat and what each says. */
  events: WatchEvent[];
  /** Every chat this read matched (the next read's `before`). */
  marks: Map<string, string>;
  /** Chats the batch still waits on (in flight or blocked on a person). */
  open: number;
  /** Lines that need a person now: the watcher exits so the lead can answer. */
  answers: number;
}

/**
 * One fleet read against the marks of the previous one. A chat whose mark
 * changed gets a line when it settled, hit a quota wall or now needs a
 * person; one still working moves silently, and a crash resume that goes on
 * by itself is watched, not told. A chat that left the matched set while it
 * was still in flight (archived, deleted) says so; one that left after it
 * settled does not, its line already went out. `complete` false means the
 * read was cut (over its limit), so a missing chat is not reported as gone.
 */
export function fleetStep(rows: FleetRow[], before: Map<string, string>, x: { machine?: string; complete?: boolean } = {}): FleetStep {
  const marks = new Map<string, string>();
  const events: WatchEvent[] = [];
  let open = 0;
  let answers = 0;
  for (const row of rows) {
    const mark = rowMark(row);
    marks.set(row.threadId, mark);
    if (before.get(row.threadId) === mark) {
      if (rowOpen(row)) open++;
      continue;
    }
    const got = watchEvent(row.threadId, row, { asking: row.asking, resetsAt: row.resetsAt, machine: x.machine });
    const ev = got ? { threadId: row.threadId, ...got } : null;
    if (rowWaitsOnPerson(row)) {
      open++;
      if (ev) { events.push(ev); answers++; }
      continue;
    }
    // waiting for its plan: one line, and the batch still waits on it (it goes on by itself)
    if (rowWaitsForPlan(row)) { open++; if (ev) events.push(ev); continue; }
    if (rowOpen(row)) { open++; continue; }
    if (ev) { events.push(ev); if (ev.kind === "asks") answers++; }
  }
  if (x.complete !== false) {
    for (const [id, mark] of before) {
      if (marks.has(id)) continue;
      if (markOpen(mark)) events.push(goneEvent(id, x.machine));
    }
  }
  return { lines: events.map(e => e.line), events, marks, open, answers };
}

const goneEvent = (id: string, machine?: string): WatchEvent =>
  ({ threadId: id, kind: "gone", line: `[lookout] ${machine ? `${machine}: ` : ""}${id} left the fleet (archived or deleted)`, ...(machine ? { machine } : {}) });

/** The line that ends a settled batch: one count per state it settled into (an open-todos settle counts its own). */
export function fleetSummary(rows: FleetRow[], machines = 1): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const state = laneOpenTodos(r) ? OPEN_TODOS : r.state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const parts = SETTLED_ORDER.filter(s => counts.has(s)).map(s => `${counts.get(s)} ${s}`);
  const where = machines > 1 ? ` across ${machines} machines` : "";
  return `[lookout] fleet settled${where}: ${parts.join(", ")}`;
}

const markState = (mark: string): string => mark.split(/[+~]/)[0] ?? mark;

/** The re-arm line at the deadline: what is still going, so the lead knows what it re-arms for.
 *  `moreMarks` are chats a cut page omitted (the lanes cursor's marks): a queued, asking, or parked
 *  chat past the limit is still the batch's, and the line names it. A plan wait never drops off this line. */
export function fleetDeadline(rows: FleetRow[], moreMarks?: Iterable<string>): string {
  const counts = new Map<string, number>();
  const add = (state: string) => counts.set(state, (counts.get(state) ?? 0) + 1);
  for (const r of rows) if (rowOpen(r) || rowWaitsForPlan(r)) add(r.state);
  if (moreMarks) for (const mark of moreMarks) {
    const state = markState(mark);
    if (mark.includes("+asking")) add("asking");
    else if (state === "parked" || state === "interrupted" || markOpen(mark)) add(state);
  }
  const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  return `[lookout] fleet still working${parts ? ` (${parts})` : ""}. Arm the watcher again.`;
}

/**
 * The lanes cursor (src/server/lane-cursor.ts): every chat the read matched, not the page `limit` cut it to.
 * Null when the string is not one of those cursors.
 */
export function decodeFleetCursor(cursor: string): Map<string, string> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v)) return null;
    const out = new Map<string, string>();
    for (const p of v) {
      if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") return null;
      out.set(p[0], p[1]);
    }
    return out;
  } catch { return null; }
}

/**
 * Chats the cursor names that this page did not. Null when the cursor is missing or does not cover the page
 * (it is not this read's matched set, so a chat absent from the page cannot be judged from it).
 */
export function offPageMarks(rows: FleetRow[], cursor: Map<string, string> | null): Map<string, string> | null {
  if (!cursor) return null;
  for (const r of rows) if (!cursor.has(r.threadId)) return null;
  const seen = new Set(rows.map(r => r.threadId));
  const off = new Map<string, string>();
  for (const [id, mark] of cursor) if (!seen.has(id)) off.set(id, mark);
  return off;
}

/**
 * Omitted chats whose lane the cursor cannot finish: a question or a workflow ask (the lead has to answer),
 * a quota wall (the line names when it resets), or `interrupted` (a pending crash resume stays open, and
 * the cursor's mark does not say which). The watcher reads those lanes by id.
 */
export function offPageNeedsDetail(off: Map<string, string>): string[] {
  const ids: string[] = [];
  for (const [id, mark] of off) {
    const state = markState(mark);
    if (state === "needs_input" || state === "interrupted" || state === "quota" || mark.includes("+asking")) ids.push(id);
  }
  return ids;
}

/**
 * Whether this read may end the batch. A complete page is settled when every row is. A cut page is settled
 * only when every omitted mark is a state the cursor describes completely (`done`, `failed`, …). An omitted
 * `interrupted` is not: the resume mark is not in the cursor, and one pending resume is still the batch's.
 * `off` null on a cut page means the rest could not be read. A plan wait (`parked`) is open, on the page
 * and in an omitted mark, so it never ends the batch.
 */
export function fleetPageSettled(rows: FleetRow[], complete: boolean, off: Map<string, string> | null): boolean {
  if (rows.some(row => rowWaitsForPlan(row) || rowOpen(row))) return false;
  if (complete) return true;
  if (!off) return false;
  for (const mark of off.values()) {
    const state = markState(mark);
    if (state === "parked" || state === "interrupted" || mark.includes("+asking") || markOpen(mark)) return false;
  }
  return true;
}

/** Rows the settled line counts: the page, plus omitted chats whose state the cursor already settled. */
export function fleetSummaryRows(rows: FleetRow[], off?: Map<string, string> | null): FleetRow[] {
  if (!off?.size) return rows;
  const extra: FleetRow[] = [];
  for (const [threadId, mark] of off) extra.push({ threadId, state: markState(mark), live: false, working: false });
  return [...rows, ...extra];
}

const atId = (id: string, machine?: string) => `${machine ? `${machine}: ` : ""}${id} (${id})`;

/**
 * A settle the page cut off. The cursor has the state and not the reply; the line still names the chat, once.
 * A question, a workflow ask and `interrupted` are not here: those lanes are read whole.
 */
export const offPageLines = (before: Map<string, string>, off: Map<string, string>, machine?: string): string[] =>
  offPageEvents(before, off, machine).map(e => e.line);

export function offPageEvents(before: Map<string, string>, off: Map<string, string>, machine?: string): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const [id, mark] of off) {
    if (before.get(id) === mark) continue;
    const state = markState(mark);
    if (!state || state === "interrupted" || state === "parked" || markOpen(mark)) continue;
    out.push({ threadId: id, kind: state, line: `[lookout] ${atId(id, machine)} ${state}`, ...(machine ? { machine } : {}) });
  }
  return out;
}

/**
 * A person is waiting on a chat the page cut off and the detail read did not return. The watcher exits on it,
 * the same as a question on the page; the line has no question text because the cursor does not carry one.
 */
export const offPageAnswers = (before: Map<string, string>, off: Map<string, string>, machine?: string): string[] =>
  offPageAnswerEvents(before, off, machine).map(e => e.line);

export function offPageAnswerEvents(before: Map<string, string>, off: Map<string, string>, machine?: string): WatchEvent[] {
  const out: WatchEvent[] = [];
  const at = (id: string, kind: WatchKind, said: string) => out.push({ threadId: id, kind, line: `[lookout] ${atId(id, machine)} ${said}`, ...(machine ? { machine } : {}) });
  for (const [id, mark] of off) {
    if (before.get(id) === mark) continue;
    const state = markState(mark);
    if (state === "needs_input") at(id, "needs_input", "needs input");
    else if (mark.includes("+asking")) at(id, "workflow_asks", "workflow asks");
  }
  return out;
}

/**
 * A chat the previous read was still waiting on, now in neither the page nor the cursor: archived or deleted.
 * One that had already settled is not named; its line already went out. `cursor` is this read's matched set.
 */
export const fleetGone = (before: Map<string, string>, rows: FleetRow[], cursor: Map<string, string>, machine?: string): string[] =>
  fleetGoneEvents(before, rows, cursor, machine).map(e => e.line);

export function fleetGoneEvents(before: Map<string, string>, rows: FleetRow[], cursor: Map<string, string>, machine?: string): WatchEvent[] {
  const seen = new Set(rows.map(r => r.threadId));
  for (const id of cursor.keys()) seen.add(id);
  const out: WatchEvent[] = [];
  for (const [id, mark] of before) if (!seen.has(id) && markOpen(mark)) out.push(goneEvent(id, machine));
  return out;
}

/** A workflow run as the watcher keeps it (scripts/watch.ts narrows the server's JSON). */
export interface RunSnap {
  runId: string;
  name: string;
  /** The view's state: running, waiting, paused, awaiting_approval, new, or an end (completed, failed, stopped, superseded). */
  state: string;
  /** The run's open asks (an approval, a program question, a cap): the first's title. */
  asks: { title?: string }[];
  /** Why nothing runs while it waits on a plan, and when that window resets. */
  waiting?: { reason?: string; until?: number };
  /**
   * The latest launch's agent calls (the view's `calls`): an agent parking at a
   * plan wall or failing while the run stays "running" surfaces only here.
   */
  agents?: { key: string; label: string; state: string; reason?: string; until?: number }[];
  error?: string | null;
}

const RUN_ENDS = new Set(["completed", "failed", "stopped", "superseded"]);

export interface RunStep {
  line: string | null;
  mark: string;
  /** The run ended, paused or waits on a person: the watcher exits. */
  exit: boolean;
}

/**
 * A run mark back to its run-level part and each agent's state. Null on a mark
 * written before agents were tracked; that mark re-reads as a change once.
 */
function runMark(mark: string | null): { run: string; agents: Record<string, string> } | null {
  if (!mark) return null;
  try {
    const v: unknown = JSON.parse(mark);
    if (!Array.isArray(v) || v.length !== 5 || !v[4] || typeof v[4] !== "object") return null;
    return { run: JSON.stringify(v.slice(0, 4)), agents: v[4] as Record<string, string> };
  } catch { return null; }
}

/**
 * Agents whose state changed since `before` into one worth a line: parked at a
 * plan wall, held before it could start, or failed while the run goes on.
 */
function agentNews(snap: RunSnap, before: Record<string, string>): string[] {
  const news: string[] = [];
  for (const a of snap.agents ?? []) {
    if (before[a.key] === a.state) continue;
    const reason = a.reason?.slice(0, 160);
    if (a.state === "failed") news.push(`${a.label} failed${reason ? `: ${reason}` : ""}`);
    else if (a.state === "parked") news.push(`${a.label} parked${reason ? ` (${reason})` : ""}${a.until ? ` until ${isoMinute(a.until)}` : ""}`);
    else if (a.state === "waiting") news.push(`${a.label} held${reason ? ` (${reason})` : ""}${a.until ? ` until ${isoMinute(a.until)}` : ""}`);
  }
  return news;
}

/**
 * One run read against the mark of the previous one. A line for an ask, an
 * end or a pause (the run goes nowhere until someone acts, so the watcher
 * exits beside the line), one for a plan wall with its reset, and one for an
 * agent of it parking or failing while the run goes on; a run that merely
 * advances says nothing. The same state twice says nothing.
 */
export function runStep(snap: RunSnap, before: string | null, machine?: string): RunStep {
  const at = `${machine ? `${machine}: ` : ""}run ${snap.name || snap.runId} (${snap.runId})`;
  const agents: Record<string, string> = {};
  for (const a of snap.agents ?? []) agents[a.key] = a.state;
  const run = JSON.stringify([snap.state, snap.asks.length, snap.waiting?.reason ?? null, snap.waiting?.until ?? null]);
  const mark = `${run.slice(0, -1)},${JSON.stringify(agents)}]`;
  if (before !== null && mark === before) return { line: null, mark, exit: false };
  if (snap.asks.length > 0 || snap.state === "awaiting_approval") {
    const q = snap.asks[0]?.title?.trim();
    return { line: q ? `[lookout] ${at} asks: ${q}` : `[lookout] ${at} asks`, mark, exit: true };
  }
  if (RUN_ENDS.has(snap.state)) {
    const why = snap.state === "failed" && snap.error ? errTail(snap.error) : "";
    return { line: `[lookout] ${at} ${snap.state}${why}`, mark, exit: true };
  }
  if (snap.state === "paused") return { line: `[lookout] ${at} paused`, mark, exit: true };
  const prev = runMark(before);
  const news = agentNews(snap, prev?.agents ?? {});
  if (snap.state === "waiting") {
    // the run-level line names the wall; only an agent change since is separate news
    if (prev !== null && prev.run === run) {
      if (news.length) return { line: `[lookout] ${at}: ${news.join("; ")}`, mark, exit: false };
      return { line: null, mark, exit: false };
    }
    const why = snap.waiting?.reason ? `: ${snap.waiting.reason}` : "";
    const until = snap.waiting?.until ? ` until ${isoMinute(snap.waiting.until)}` : "";
    return { line: `[lookout] ${at} waiting${why}${until}`, mark, exit: false };
  }
  if (news.length) return { line: `[lookout] ${at}: ${news.join("; ")}`, mark, exit: false };
  return { line: null, mark, exit: false };
}

/** Just under Monitor's 30 minute kill, so a still-running chat can be re-armed. */
export const WATCH_MAX_MS = 29 * 60 * 1000;

export function deadlineLine(threadId: string): string {
  return `[lookout] ${threadId} still working. Arm the watcher again.`;
}

/** The re-arm line at the deadline for a run (on `machine` when it isn't this one). */
export function runDeadline(snap: RunSnap, machine?: string): string {
  return `[lookout] ${machine ? `${machine}: ` : ""}run ${snap.name || snap.runId} (${snap.runId}) still ${snap.state}. Arm the watcher again.`;
}

/**
 * The one line a follow watcher prints when Monitor's cap ends it: what it still follows, and that nothing it saw
 * is told twice when it is armed again with the same filters.
 */
export function followDeadline(rows: FleetRow[], filters: string): string {
  const counts = new Map<string, number>();
  for (const r of rows) if (rowOpen(r) || rowWaitsForPlan(r)) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const going = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  return `[lookout] follow (${filters}) reached Monitor's 30 minute cap${going ? ` with ${going}` : ""}: arm the same command again (nothing it told is told twice), or add these filters to the plugin's monitor with --follow --add, which needs no arming.`;
}

/**
 * Chats a follow watcher sees for the first time, its filter just added: the ones a person waits on, and the ones that
 * settled within this long, are told; older settles are history, not news.
 */
export const FOLLOW_RECENT_MS = 15 * 60_000;

export function primeNews(row: FleetRow, now: number): boolean {
  if (rowWaitsOnPerson(row)) return true;
  if (rowOpen(row)) return false;
  return typeof row.updatedAt === "number" && now - row.updatedAt <= FOLLOW_RECENT_MS;
}

/** What the session's monitor follows (follow.json `follows`): lane prefixes, chat ids, and the machines to read. */
export interface Follows { lanePrefixes: string[]; threads: string[]; machines?: string }

const followStrings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map(s => s.trim()))].slice(0, 40) : [];

export function followsOf(v: unknown): Follows {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const machines = typeof o.machines === "string" ? o.machines.trim() : "";
  return { lanePrefixes: followStrings(o.lanePrefixes), threads: followStrings(o.threads), ...(machines ? { machines } : {}) };
}

/** `remove` drops the named filters; `machines` "" clears the machine choice. */
export function editFollows(prev: Follows, edit: { remove?: boolean; lanePrefixes: string[]; threads: string[]; machines?: string }): Follows {
  const merge = (a: string[], b: string[]) => edit.remove ? a.filter(x => !b.includes(x)) : [...new Set([...a, ...b])];
  const machines = edit.machines === undefined ? prev.machines : edit.remove ? undefined : edit.machines || undefined;
  return followsOf({ lanePrefixes: merge(prev.lanePrefixes, edit.lanePrefixes), threads: merge(prev.threads, edit.threads), machines });
}

export function followsLabel(f: Follows): string {
  const parts = [...f.lanePrefixes.map(p => `lane prefix ${p}`), ...(f.threads.length ? [`${f.threads.length} named chat${f.threads.length === 1 ? "" : "s"}`] : [])];
  return parts.length ? `${parts.join(", ")}${f.machines ? ` on ${f.machines === "*" ? "every machine" : f.machines}` : ""}` : "nothing";
}

/** Skip a line the previous arm already printed. */
export function unseen(cursor: string | null, line: string): boolean {
  return cursor !== line;
}
