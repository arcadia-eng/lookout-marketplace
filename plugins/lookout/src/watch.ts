// The Monitor watcher: one line when a Lookout chat settles or needs a
// person, nothing while it is working. SSE frames are split here so the
// script can be tested without a server, and the fleet and run steps turn a
// snapshot plus the marks of the previous read into the lines a batch
// watcher prints: one per settle, needs_input, quota wall (with the reset)
// or workflow ask, never the same event twice across a cursor. A chat that
// waits out its plan (state parked) gets one line and stays watched.

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
  /** State parked: the model whose plan it waits for, and the reset (the lane's `parked`). */
  parked?: { until?: number; model?: string };
}

/** States that still need the watcher to stay open. */
const OPEN = new Set(["running", "background", "compacting", "restoring"]);

/** Every state a chat moves through on its way to an answer (a fleet adds new and queued). */
const IN_FLIGHT = new Set(["new", "running", "queued", "background", "compacting", "restoring"]);

/** The states a batch settles into, display order; anything else a lane may one day say is still watched, not told. */
const SETTLED_ORDER = ["done", "incomplete", "stopped", "quota", "failed", "interrupted"] as const;
const SETTLED = new Set<string>(SETTLED_ORDER);

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
const replyTail = (reply?: string, chars = 240) => {
  const t = reply?.trim();
  return t ? `: ${t.slice(0, chars)}` : "";
};

/**
 * A line for Monitor, or null to keep waiting. `needs_input` and a workflow
 * ask are lines: someone has to answer, and waiting further would hide that.
 * A quota wall names when the plan resets; a chat that waits for its plan
 * says whose and until when (the watcher prints it and keeps watching:
 * rowWaitsForPlan); every other settle carries the reply's opening.
 */
export function watchLine(threadId: string, lane: LaneSnap | null, x: WatchExtras = {}): string | null {
  if (!lane) return null;
  const title = lane.title?.trim() || threadId;
  const at = `${x.machine ? `${x.machine}: ` : ""}${title} (${threadId})`;
  if (lane.state === "parked" && !lane.live) {
    const plan = lane.parked?.model ? `${lane.parked.model}'s plan` : "its plan";
    return `[lookout] ${at} waiting for ${plan}${lane.parked?.until ? ` until ${isoMinute(lane.parked.until)}` : ""}`;
  }
  if (lane.state === "needs_input") {
    const q = lane.question?.trim();
    return q ? `[lookout] ${at} needs input: ${q}` : `[lookout] ${at} needs input`;
  }
  if ((x.asking ?? 0) > 0) return `[lookout] ${at} workflow asks (${x.asking} open)`;
  if (lane.working || lane.live || OPEN.has(lane.state)) return null;
  if (lane.state === "quota") {
    const resets = x.resetsAt ? ` (resets ${isoMinute(x.resetsAt)})` : "";
    return `[lookout] ${at} quota${resets}${replyTail(lane.lastReply)}`;
  }
  return `[lookout] ${at} ${lane.state}${replyTail(lane.lastReply)}`;
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

/** The mark a fleet read keeps of a chat: its state, a workflow ask, a crash resume. */
export function rowMark(row: FleetRow): string {
  return `${row.state}${(row.asking ?? 0) > 0 ? "+asking" : ""}${row.crashResume ? `~${row.crashResume}` : ""}`;
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
  const lines: string[] = [];
  let open = 0;
  let answers = 0;
  for (const row of rows) {
    const mark = rowMark(row);
    marks.set(row.threadId, mark);
    if (before.get(row.threadId) === mark) {
      if (rowOpen(row)) open++;
      continue;
    }
    const line = watchLine(row.threadId, row, { asking: row.asking, resetsAt: row.resetsAt, machine: x.machine });
    if (rowWaitsOnPerson(row)) {
      open++;
      if (line) { lines.push(line); answers++; }
      continue;
    }
    // waiting for its plan: one line, and the batch still waits on it (it goes on by itself)
    if (rowWaitsForPlan(row)) { open++; if (line) lines.push(line); continue; }
    if (rowOpen(row)) { open++; continue; }
    if (line) lines.push(line);
  }
  if (x.complete !== false) {
    const scope = x.machine ? `${x.machine}: ` : "";
    for (const [id, mark] of before) {
      if (marks.has(id)) continue;
      if (markOpen(mark)) lines.push(`[lookout] ${scope}${id} left the fleet (archived or deleted)`);
    }
  }
  return { lines, marks, open, answers };
}

/** The line that ends a settled batch: one count per state it settled into. */
export function fleetSummary(rows: FleetRow[], machines = 1): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const parts = SETTLED_ORDER.filter(s => counts.has(s)).map(s => `${counts.get(s)} ${s}`);
  const where = machines > 1 ? ` across ${machines} machines` : "";
  return `[lookout] fleet settled${where}: ${parts.join(", ")}`;
}

/** The re-arm line at the deadline: what is still going, so the lead knows what it re-arms for. */
export function fleetDeadline(rows: FleetRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) if (rowOpen(r)) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  return `[lookout] fleet still working${parts ? ` (${parts})` : ""}. Arm the watcher again.`;
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
 * One run read against the mark of the previous one. A line for an ask, an
 * end or a pause (the run goes nowhere until someone acts, so the watcher
 * exits beside the line), and one for a plan wall with its reset; a run that
 * merely advances says nothing. The same state twice says nothing.
 */
export function runStep(snap: RunSnap, before: string | null): RunStep {
  const at = `run ${snap.name || snap.runId} (${snap.runId})`;
  const mark = `${snap.state}|${snap.asks.length}|${snap.waiting?.reason ?? ""}|${snap.waiting?.until ?? ""}`;
  if (before !== null && mark === before) return { line: null, mark, exit: false };
  if (snap.asks.length > 0 || snap.state === "awaiting_approval") {
    const q = snap.asks[0]?.title?.trim();
    return { line: q ? `[lookout] ${at} asks: ${q}` : `[lookout] ${at} asks`, mark, exit: true };
  }
  if (RUN_ENDS.has(snap.state)) {
    const why = snap.state === "failed" && snap.error ? replyTail(snap.error) : "";
    return { line: `[lookout] ${at} ${snap.state}${why}`, mark, exit: true };
  }
  if (snap.state === "paused") return { line: `[lookout] ${at} paused`, mark, exit: true };
  if (snap.state === "waiting") {
    const why = snap.waiting?.reason ? `: ${snap.waiting.reason}` : "";
    const until = snap.waiting?.until ? ` until ${isoMinute(snap.waiting.until)}` : "";
    return { line: `[lookout] ${at} waiting${why}${until}`, mark, exit: false };
  }
  return { line: null, mark, exit: false };
}

/** Just under Monitor's 30 minute kill, so a still-running chat can be re-armed. */
export const WATCH_MAX_MS = 29 * 60 * 1000;

export function deadlineLine(threadId: string): string {
  return `[lookout] ${threadId} still working. Arm the watcher again.`;
}

/** The re-arm line at the deadline for a run. */
export function runDeadline(snap: RunSnap): string {
  return `[lookout] run ${snap.name || snap.runId} (${snap.runId}) still ${snap.state}. Arm the watcher again.`;
}

/** Skip a line the previous arm already printed. */
export function unseen(cursor: string | null, line: string): boolean {
  return cursor !== line;
}
