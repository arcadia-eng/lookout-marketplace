// Text for /lookout:status, the session-start hook, and the status line.
// Credential fields are dropped on purpose: this is a glance, not a dump.

export interface MeterSnap {
  label?: string;
  leftPercent?: number;
  exhausted?: boolean;
}

export interface ProviderSnap {
  id: string;
  name?: string;
  connection: string;
  plan?: string | null;
  metered?: boolean;
  meters?: MeterSnap[];
  credential?: unknown;
}

export interface LaneSnap {
  threadId: string;
  title?: string;
  state: string;
  working?: boolean;
  lane?: string | null;
}

export interface MachineSnap {
  id: string;
  name: string;
  presence: string;
  thisMachine?: boolean;
  presenceDetail?: string | null;
}

const WORKING = new Set(["running", "needs_input", "background", "compacting", "restoring"]);

export function liveLanes(lanes: readonly LaneSnap[]): LaneSnap[] {
  return lanes.filter(l => l.working || WORKING.has(l.state));
}

/** One status-line segment. Empty when nothing is running, so the bar stays quiet. */
export function runningSegment(lanes: readonly LaneSnap[]): string {
  const live = liveLanes(lanes);
  if (!live.length) return "";
  const needs = live.filter(l => l.state === "needs_input").length;
  const base = `lookout ${live.length} running`;
  return needs ? `${base}, ${needs} need input` : base;
}

export function fleetLines(lanes: readonly LaneSnap[]): string[] {
  const live = liveLanes(lanes);
  if (!live.length) return ["No Lookout chats are running."];
  return live.map(l => {
    const title = l.title?.trim() || l.threadId;
    const lane = l.lane ? ` lane ${l.lane}` : "";
    return `- ${title} (${l.threadId}) ${l.state}${lane}`;
  });
}

export function machineLines(machines: readonly MachineSnap[]): string[] {
  if (!machines.length) return ["No machines reported."];
  return machines.map(m => {
    const here = m.thisMachine ? " (this machine)" : "";
    const detail = m.presenceDetail ? `: ${m.presenceDetail}` : "";
    return `- ${m.name}${here} ${m.presence}${detail}`;
  });
}

export function quotaLines(providers: readonly ProviderSnap[]): string[] {
  if (!providers.length) return ["No provider state."];
  return providers.map(p => {
    const name = p.name ?? p.id;
    const plan = p.plan ? ` ${p.plan}` : "";
    const windows = (p.meters ?? []).map(m => {
      const label = m.label ?? "window";
      const left = typeof m.leftPercent === "number" ? `${Math.round(m.leftPercent)}% left` : "unread";
      return `${label} ${left}${m.exhausted ? " spent" : ""}`;
    });
    const meter = windows.length ? windows.join(", ") : (p.metered === false ? "unmetered" : "no windows");
    return `- ${name} (${p.id}) ${p.connection}${plan}: ${meter}`;
  });
}

export interface StatusInput {
  app: string;
  lanes: readonly LaneSnap[];
  machines: readonly MachineSnap[];
  providers: readonly ProviderSnap[];
  notes?: readonly string[];
}

/** The /lookout:status report. Never includes credential objects. */
export function renderStatus(input: StatusInput): string {
  const parts = [
    `Lookout at ${input.app}`,
    "",
    "Running",
    ...fleetLines(input.lanes),
    "",
    "Machines",
    ...machineLines(input.machines),
    "",
    "Quotas",
    ...quotaLines(input.providers),
  ];
  if (input.notes?.length) parts.push("", ...input.notes);
  return parts.join("\n");
}

/** True when a rendered report leaked a marker the caller planted in a credential. */
export function leaked(report: string, secret: string): boolean {
  return secret.length > 0 && report.includes(secret);
}
