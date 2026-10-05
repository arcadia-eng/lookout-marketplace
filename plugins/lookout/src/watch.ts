// The Monitor watcher: one line when a Lookout chat settles or needs a
// person, nothing while it is working. SSE frames are split here so the
// script can be tested without a server.

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
}

/** States that still need the watcher to stay open. */
const OPEN = new Set(["running", "background", "compacting", "restoring"]);

/**
 * A line for Monitor, or null to keep waiting. `needs_input` is a line:
 * someone has to answer, and waiting further would hide that.
 */
export function watchLine(threadId: string, lane: LaneSnap | null): string | null {
  if (!lane) return null;
  const title = lane.title?.trim() || threadId;
  if (lane.state === "needs_input") {
    const q = lane.question?.trim();
    return q
      ? `[lookout] ${title} (${threadId}) needs input: ${q}`
      : `[lookout] ${title} (${threadId}) needs input`;
  }
  if (lane.working || lane.live || OPEN.has(lane.state)) return null;
  const reply = lane.lastReply?.trim();
  const tail = reply ? `: ${reply.slice(0, 240)}` : "";
  return `[lookout] ${title} (${threadId}) ${lane.state}${tail}`;
}

/** Just under Monitor's 30 minute kill, so a still-running chat can be re-armed. */
export const WATCH_MAX_MS = 29 * 60 * 1000;

export function deadlineLine(threadId: string): string {
  return `[lookout] ${threadId} still working. Arm the watcher again.`;
}

/** Skip a line the previous arm already printed. */
export function unseen(cursor: string | null, line: string): boolean {
  return cursor !== line;
}
