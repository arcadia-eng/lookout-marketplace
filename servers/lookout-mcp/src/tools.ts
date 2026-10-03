// The Lookout session surface as MCP tools. Every tool is a thin adapter over
// the loopback HTTP API (client.ts), so a Grok-driven session is byte-for-byte
// the same object the owner sees in the Lookout UI: same SQLite rows, same
// live stream, same steering and Stop. Coding outlasts an MCP call, so the
// shape is async: delegate returns a thread id immediately, check polls it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { basename, isAbsolute, resolve } from "node:path";
import { canonicalPath } from "./paths.js";
import { LookoutClient, LookoutError, type EntryOut, type ModelRow, type ProjectOut, type ThreadDetail, type ThreadOut } from "./client.js";
import { BRANDING, serverIcons } from "./branding.js";

export interface ToolOptions {
  /** Canonical roots delegate may create workspaces under; empty = existing projects only. */
  roots: string[];
  /** Public base URL Grok reaches (e.g. https://mcp.…): the icon origin advertised in serverInfo. */
  publicUrl: string;
  /**
   * Per-grant tool scope: the tools this client may see and call. Null (or
   * absent) is the full surface; a list registers only its members, so
   * tools/list filters itself. tools/call outside the scope never reaches
   * the server: app.ts refuses it with a scope-naming error first.
   */
  allowedTools?: readonly string[] | null;
}

/**
 * The bridge's canonical tool inventory, alphabetical. The Customize scope
 * editor duplicates these names as UI copy (src/customize/connector-tools.ts,
 * pinned by its test); the origin validates scope syntax only and the bridge
 * intersects every scope with this list, so an unknown name matches nothing.
 */
export const LOOKOUT_MCP_TOOL_NAMES: readonly string[] = [
  "lookout_answer", "lookout_cancel_task", "lookout_check", "lookout_compact",
  "lookout_configure", "lookout_configure_project", "lookout_create_project",
  "lookout_delegate", "lookout_delete_project", "lookout_delete_thread",
  "lookout_list", "lookout_models", "lookout_projects", "lookout_restore",
  "lookout_rewind", "lookout_status", "lookout_steer", "lookout_stop",
  "lookout_task_transcript", "lookout_tasks", "lookout_usage", "lookout_usage_local",
];

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});
const call = async (fn: () => Promise<unknown>) => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof LookoutError) return fail(`${e.message} (${e.status})`);
    return fail(e instanceof Error ? e.message : `mcp: ${e}`);
  }
};

const canonical = (p: string) => canonicalPath(resolve(p));
const underRoots = (ws: string, roots: string[]) =>
  roots.some(r => ws === r || ws.startsWith(`${r}/`));

/**
 * A message starting with `#` is the harness memory shortcut (no model turn).
 * Grok means a turn, so a leading `#` is escaped with a zero-width space
 * (a plain space would not survive the server's trim), and the call notes it,
 * so the transcript never silently disagrees with what Grok sent.
 */
function escapeMemoryShortcut(text: string): { text: string; note?: string } {
  if (/^\s*#/.test(text))
    return { text: `\u200b${text}`, note: "Leading # escaped (unescaped it would be a memory write, not a turn)." };
  return { text };
}

// Tool results are bounded but never cut silently: overlong strings and arrays
// keep a marker naming the cut, and the entry tail keeps a cursor (lastSeq)
// so the rest is one more check away.
const MAX_STR = 2000;
const MAX_ARR = 30;
/** Whole-result cap for lookout_check; the tail shrinks to fit. */
const MAX_CHECK_BYTES = 48_000;
/** Transcript tail for lookout_task_transcript: the run's recent steps, not its setup. */
const MAX_TRANSCRIPT_CHARS = 24_000;
function bound(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…[truncated ${v.length - MAX_STR} chars]` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARR).map(bound);
    if (v.length > MAX_ARR) out.push(`…[truncated ${v.length - MAX_ARR} items]`);
    return out;
  }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = bound(val);
    return o;
  }
  return v;
}

// --- naming: the MCP surface speaks camelCase; the loopback API speaks
// snake_case rows. Payload bodies keep engine vocabulary (tool args like
// old_string stay snake_case) and provider usage blobs pass through untouched.
function rename(o: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const [from, to] of Object.entries(map)) {
    if (from in out) {
      if (!(to in out)) out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}
const THREAD_KEYS = {
  project_id: "projectId", created_at: "createdAt", updated_at: "updatedAt", last_stop_reason: "lastStopReason",
  archived_at: "archivedAt", pinned_at: "pinnedAt", read_at: "readAt", parent_id: "parentId", fork_seq: "forkSeq",
};
const camelThread = (t: ThreadOut) => rename(t, THREAD_KEYS);
const camelProject = (p: ProjectOut) => rename(p, { created_at: "createdAt", updated_at: "updatedAt" });
const camelModel = (m: ModelRow) => rename(m, { owned_by: "ownedBy" });

// --- effort echo: the server clamps a level the model doesn't take (Max on
// plain Spark runs at Extra high) without saying so. The bridge echoes what
// was asked against what landed, plus the allowed ladder when they differ.
interface EffortEcho { requested: string; applied: string; allowed?: string[] }
async function effortEcho(client: LookoutClient, requested: string, applied: string | null, model?: string | null, projectId?: string): Promise<EffortEcho> {
  const echo: EffortEcho = { requested, applied: applied ?? requested };
  if (echo.applied === requested) return echo;
  let id = model ?? undefined;
  if (!id && projectId) {
    try { id = (await client.projects()).projects.find(p => p.id === projectId)?.model; } catch { /* the ladder is advisory */ }
  }
  if (!id) return echo;
  try {
    // the full catalog, not the connected-only listing: a clamp can name a
    // model the gate hides, and its ladder is still the truth to echo
    const row = (await client.models(true)).data.find(m => m.id === id);
    if (row?.efforts?.length) echo.allowed = row.efforts;
  } catch { /* the ladder is advisory */ }
  return echo;
}

// --- tool scan: one pass over the snapshot's entries for the summary's tool
// names and the status line's in-flight call. No extra reads.
interface ToolCall { id: string; name: string; args: string; seq: number }
function itemOf(e: EntryOut): Record<string, unknown> | undefined {
  const p = e.payload as Record<string, unknown> | null;
  const it = p && typeof p === "object" ? p.item : undefined;
  return it && typeof it === "object" ? it as Record<string, unknown> : undefined;
}
function scanTools(entries: EntryOut[]): { calls: ToolCall[]; resultIds: Set<string>; names: string[]; count: number } {
  const calls: ToolCall[] = [];
  const resultIds = new Set<string>();
  const seen = new Map<string, { name: string; seq: number }>();
  for (const e of entries) {
    const item = itemOf(e);
    if (!item) continue;
    if (item.type === "response" && Array.isArray(item.parts)) {
      for (const pt of item.parts as Record<string, unknown>[]) {
        if (pt && pt.type === "call" && typeof pt.id === "string") {
          const name = typeof pt.name === "string" && pt.name ? pt.name : "tool";
          calls.push({ id: pt.id, name, args: typeof pt.args === "string" ? pt.args : "", seq: e.seq });
          if (!seen.has(pt.id)) seen.set(pt.id, { name, seq: e.seq });
        }
      }
    } else if (item.type === "result" && typeof item.callId === "string") {
      resultIds.add(item.callId);
      if (!seen.has(item.callId))
        seen.set(item.callId, { name: typeof item.name === "string" && item.name ? item.name : "tool", seq: e.seq });
    }
  }
  const names = [...seen.values()].sort((a, b) => a.seq - b.seq).slice(-10).map(t => t.name);
  return { calls, resultIds, names, count: seen.size };
}

// --- status line: the tri-state the app's own stream tail shows (turn.tsx
// TailStatus), derived from the one snapshot a check already fetches.
const TOOL_VERBS: Record<string, string> = {
  Read: "reading", Write: "writing", StrReplace: "editing", Delete: "deleting", Ls: "listing",
  Glob: "searching files", Grep: "grepping", Shell: "running", AwaitShell: "waiting on",
  Fetch: "fetching", WebSearch: "searching the web", Task: "working on task", TodoWrite: "updating to-dos",
  AskQuestion: "asking", CreatePlan: "writing plan", ReadLints: "reading lints",
  SwitchMode: "switching mode", SaveMemory: "saving memory",
};
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
function toolTarget(name: string, args: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  switch (name) {
    case "Read": case "Write": case "StrReplace": case "Delete": {
      const p = s(args.path);
      return p ? basename(p) : undefined;
    }
    case "Ls": {
      const p = s(args.path) ?? s(args.target_directory);
      return p ? basename(p) || "." : ".";
    }
    case "Glob": return s(args.pattern) ?? s(args.glob_pattern);
    case "Grep": return s(args.pattern);
    case "Shell": return s(args.description) ?? (s(args.command) ? short(s(args.command)!, 40) : undefined);
    case "AwaitShell":
      return typeof args.shell_id === "number" || typeof args.shell_id === "string" ? `#${args.shell_id}` : s(args.description);
    case "Fetch": {
      const u = s(args.url);
      if (!u) return undefined;
      try {
        const x = new URL(u);
        return short(x.host + (x.pathname === "/" ? "" : x.pathname), 56);
      } catch { return short(u, 56); }
    }
    case "WebSearch": return s(args.query) ?? s(args.search_term);
    case "Task": return s(args.description);
    case "CreatePlan": return s(args.name);
    default: return undefined;
  }
}
function toolPhrase(c: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const p = JSON.parse(c.args || "{}") as unknown;
    if (p && typeof p === "object") args = p as Record<string, unknown>;
  } catch { /* the model's bytes weren't JSON: the name still reads */ }
  const verb = TOOL_VERBS[c.name];
  if (!verb) return `${c.name} #${c.seq}`;
  const target = toolTarget(c.name, args);
  return `${verb}${target ? ` ${target}` : ""} · ${c.name} #${c.seq}`;
}
function liveActivity(entries: EntryOut[]): string {
  if (!entries.length) return "starting";
  const { calls, resultIds } = scanTools(entries);
  const flying = calls.filter(c => !resultIds.has(c.id)).at(-1);
  return flying ? toolPhrase(flying) : "planning next moves";
}
function buildStatusLine(d: ThreadDetail): string {
  if (d.pendingQuestion) return `needs-you · ${short(d.pendingQuestion.title || "question pending", 60)}`;
  const tasks = Array.isArray(d.tasks) ? d.tasks as Record<string, unknown>[] : [];
  const running = tasks.filter(t => t && t.status === "running").length;
  if (!d.live && (running > 0 || d.backgroundPending > 0))
    return `working · background tasks running${running ? ` (${running})` : ""}`;
  if (d.live) return `working · ${liveActivity(d.entries)}`;
  const stop = d.thread.last_stop_reason;
  return `done · ${stop && typeof stop === "string" ? stop : "idle"}`;
}

// includeResults:false keeps the calls and drops what they returned: result
// items hold their status and a pointer back to the full check.
const RESULTS_OMITTED = "[result body omitted: re-check with includeResults (default true) for it]";
function stripResults(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  const item = p.item as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object" || item.type !== "result") return payload;
  const { parts: _parts, display: _display, ...kept } = item;
  return { ...p, item: { ...kept, parts: [{ type: "text", text: RESULTS_OMITTED }] } };
}

const settingsShape = {
  model: z.string().optional().describe("Model id from lookout_models (e.g. a Spark or GPT row). Omit for the project default."),
  effort: z.string().optional().describe("Reasoning level from the model's ladder in lookout_models. Clamped to the nearest level the model takes."),
  mode: z.enum(["agent", "plan", "debug", "ask"]).optional().describe("agent works, plan writes .lookout/plans/*.md instead of editing, debug diagnoses, ask only answers."),
  multitask: z.boolean().nullable().optional().describe("Agent option: coordinate background Task workers. Null follows the project."),
};

const projectSettingsShape = {
  model: z.string().optional().describe("Model id from lookout_models. Omit for the server default."),
  effort: z.string().optional().describe("Reasoning level from the model's ladder in lookout_models. Clamped to the nearest level the model takes."),
  mode: z.enum(["agent", "plan", "debug", "ask"]).optional().describe("Default mode for new chats: agent works, plan writes .lookout/plans/*.md instead of editing, debug diagnoses, ask only answers."),
  multitask: z.boolean().optional().describe("Agent option: new chats coordinate background Task workers."),
};

// One version source: the package manifest. A declarative JSON import (no
// side effects), so the export index stays side-effect free while the
// initialize serverInfo, the package and the marketplace listing can never
// drift apart.
import pkg from "../package.json" with { type: "json" };
export const LOOKOUT_MCP_VERSION: string = pkg.version;

export function buildMcpServer(client: LookoutClient, opts: ToolOptions): McpServer {
  // normalize once: a roots entry through a symlink (/tmp on macOS) must match canonically
  const roots = opts.roots.map(canonical);
  // Full SEP-973 identity: name + title/description/websiteUrl/icons ride
  // the initialize result's serverInfo (post-auth on this transport).
  const server = new McpServer(
    {
      name: "lookout", version: LOOKOUT_MCP_VERSION,
      title: BRANDING.title, description: BRANDING.description, websiteUrl: BRANDING.websiteUrl,
      icons: serverIcons(opts.publicUrl),
    },
    { capabilities: { tools: {} } },
  );
  // tools/list filters itself: a scoped client registers only its scope.
  const allow = opts.allowedTools == null ? null : new Set(opts.allowedTools);
  let registered = 0;
  const gate = ((name: string, ...rest: unknown[]) => {
    if (allow && !allow.has(name)) return;
    (server.tool as (...args: unknown[]) => void)(name, ...rest);
    registered++;
  }) as typeof server.tool;

  gate("lookout_status", "Lookout at a glance: server load, curated models, plan usage per provider, projects and running chats. Call before delegating.", {},
    () => call(async () => {
      const [health, models, projects] = await Promise.all([client.health(), client.models(), client.projects()]);
      const threads = (await Promise.all(projects.projects.map(p =>
        client.projectThreads(p.id).then(r => r.threads.map(t => ({ ...t, project: p.name, workspace: p.workspace }))).catch(() => [] as unknown[]),
      ))).flat() as { id: string; project_id: string; title: string; last_stop_reason: string | null; project: string }[];
      const usage: Record<string, unknown> = {};
      for (const p of ["muse", "zai", "chatgpt"] as const) {
        try { usage[p] = await client.providerUsage(p); } catch { usage[p] = { error: "unavailable" }; }
      }
      try { usage.devin = await client.devinStatus(); } catch { usage.devin = { error: "unavailable" }; }
      return {
        busy: health.busy, memoryPending: health.memoryPending,
        models: models.data.map(m => ({ id: m.id, label: m.label, provider: m.provider, efforts: m.efforts, defaultEffort: m.defaultEffort })),
        usage,
        projects: projects.projects.map(p => ({ id: p.id, name: p.name, workspace: p.workspace, model: p.model, effort: p.effort, mode: p.mode, multitask: p.multitask })),
        threads: threads.map(t => ({ id: t.id, projectId: t.project_id, project: t.project, title: t.title, lastStopReason: t.last_stop_reason })),
      };
    }));

  gate("lookout_models", "Curated model picker rows with effort ladders and context budgets. Every id here is a concrete model a chat can store.",
    {},
    () => call(async () => (await client.models()).data.map(camelModel)));

  gate("lookout_usage", "Remaining usage the way each provider's own app shows it (plan windows, not tokens), so a run never fails blind on an exhausted plan.",
    { provider: z.enum(["muse", "zai", "chatgpt", "devin"]).optional().describe("One provider, or all when omitted.") },
    ({ provider }) => call(async () => {
      if (!provider) {
        const [muse, zai, chatgpt, devin] = await Promise.all([
          client.providerUsage("muse").catch((e: unknown) => ({ error: String(e) })),
          client.providerUsage("zai").catch((e: unknown) => ({ error: String(e) })),
          client.providerUsage("chatgpt").catch((e: unknown) => ({ error: String(e) })),
          client.devinStatus().catch((e: unknown) => ({ error: String(e) })),
        ]);
        return { muse, zai, chatgpt, devin };
      }
      return provider === "devin" ? client.devinStatus() : client.providerUsage(provider);
    }));

  gate("lookout_usage_local", "This machine's token usage (the Usage tab): turns newest first plus summed totals for the period. Totals cover the whole period; requests is the bounded newest slice.",
    {
      days: z.number().int().min(1).max(365).optional().describe("Days back, default 30."),
      limit: z.number().int().min(1).max(500).optional().describe("Max turns, default 50."),
    },
    ({ days, limit }) => call(async () => {
      const d = await client.localUsage(days ?? 30);
      const n = limit ?? 50;
      const requests = d.requests.slice(0, n);
      return {
        totals: d.totals,
        requests,
        showing: requests.length,
        total: d.requests.length,
        ...(d.requests.length > requests.length ? { spilled: `Showing the newest ${requests.length} of ${d.requests.length} turns; raise limit (max 500) for more.` } : {}),
      };
    }));

  gate("lookout_list", "Recent chats (newest first): recovers a lost thread id, or scopes to one project.",
    {
      projectId: z.string().optional().describe("List only this project's chats (a project id from lookout_status); omit for every project."),
      limit: z.number().int().min(1).max(100).optional().describe("Max chats, default 20."),
    },
    ({ projectId, limit }) => call(async () => {
      const projects = (await client.projects()).projects.filter(p => !projectId || p.id === projectId);
      const groups = await Promise.all(projects.map(async p => ({
        project: { id: p.id, name: p.name, workspace: p.workspace },
        threads: (await client.projectThreads(p.id)).threads,
      })));
      return groups.flatMap(g => g.threads.map(t => ({ t, project: g.project })))
        .sort((a, b) => b.t.updated_at - a.t.updated_at).slice(0, limit ?? 20)
        .map(({ t, project }) => ({ ...camelThread(t), project }));
    }));

  gate("lookout_projects", "Projects (full rows): every project, or one by id. For a project's chats use lookout_list.",
    { projectId: z.string().optional().describe("One project id (from lookout_status); omit for all.") },
    ({ projectId }) => call(async () => {
      const projects = (await client.projects()).projects;
      if (!projectId) return projects.map(camelProject);
      const hit = projects.find(p => p.id === projectId);
      if (!hit) throw new Error(`unknown project "${projectId}"`);
      return camelProject(hit);
    }));

  gate("lookout_create_project",
    "EMPTY SHELLS ONLY: for actual work skip this tool: lookout_delegate creates the project itself. Makes a project without starting work: an explicit workspace (created if absent, under the allowed roots), a scratch folder, or a server-chosen one.",
    {
      workspace: z.string().optional().describe("Absolute folder for the project. Created if absent; must sit under the server's allowed roots. Omit for scratch/server-chosen."),
      name: z.string().max(120).optional().describe("Project name; defaults to the folder name (unique)."),
      description: z.string().max(2000).optional().describe("What this project is for."),
      scratch: z.boolean().optional().describe("No repo: a real folder under the server's workspace pool. Ignored when workspace is given."),
      ...projectSettingsShape,
    },
    ({ workspace, name, description, scratch, ...settings }) => call(async () => {
      let ws: string | undefined;
      if (workspace) {
        if (!isAbsolute(workspace)) throw new Error("workspace must be an absolute path.");
        ws = canonical(workspace);
        if (!roots.length || !underRoots(ws, roots))
          throw new Error(roots.length ? `workspace is outside the allowed roots: ${roots.join(", ")}` : "this server only creates scratch projects: omit workspace (or pass scratch: true), or delegate into an existing projectId.");
      }
      const project = (await client.createProject({
        ...(ws ? { workspace: ws, name: name ?? basename(resolve(workspace!)) } : {}),
        ...(!ws && name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(!ws && scratch ? { scratch: true } : {}),
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.mode ? { mode: settings.mode } : {}),
        ...(settings.multitask !== undefined ? { multitask: settings.multitask } : {}),
      })).project;
      return {
        ...camelProject(project),
        hint: "Empty project shell: no chat, no work started. For actual work use lookout_delegate (it creates the project from a workspace in one call).",
      };
    }));

  gate("lookout_configure_project", "Retune a project's defaults: name, description, model, effort, mode, multitask. New chats copy them; a chat's own picks win. An explicit effort echoes what the model's ladder allowed.",
    {
      projectId: z.string().describe("The project id (from lookout_status, lookout_projects, or lookout_delegate)."),
      name: z.string().max(120).optional().describe("Project name."),
      description: z.string().max(2000).optional().describe("What this project is for."),
      ...projectSettingsShape,
    },
    ({ projectId, name, description, ...settings }) => call(async () => {
      const project = (await client.patchProject(projectId, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...settings,
      })).project;
      if (settings.effort === undefined) return camelProject(project);
      return {
        ...camelProject(project),
        effortEcho: await effortEcho(client, settings.effort, project.effort, settings.model ?? project.model),
      };
    }));

  gate("lookout_delete_project", "Delete a project and all its chats. The workspace folder on disk is kept.",
    { projectId: z.string().describe("The project id (from lookout_status, lookout_projects, or lookout_delegate).") },
    ({ projectId }) => call(async () => client.deleteProject(projectId)));

  gate("lookout_delegate",
    "Do work in ONE call (no prior create needed): makes (or reuses) a project from workspace/projectId plus a chat, sends the prompt, and returns the thread id immediately: the turn runs on. Poll lookout_check for progress; follow-ups reuse the thread id via lookout_steer, never a fresh delegate. Omit prompt for an empty chat (no turn).",
    {
      prompt: z.string().min(1).max(1_000_000).optional().describe("The task, as you would brief a strong engineer: goal, context, constraints. Omit for an empty chat."),
      workspace: z.string().optional().describe("Absolute folder the work happens in. Created if absent; must sit under the server's allowed roots. Omit when projectId names the project. Cold start: workspace + prompt alone is enough."),
      projectId: z.string().optional().describe("Existing project id (from lookout_status or lookout_list). Wins over workspace when both are given."),
      title: z.string().max(120).optional().describe("Chat title; the harness titles it when omitted."),
      ...settingsShape,
    },
    ({ prompt, workspace, projectId, title, ...settings }) => call(async () => {
      let pid = projectId;
      let projectModel: string | undefined;
      if (!pid) {
        if (!workspace) throw new Error("delegate needs workspace or projectId: workspace creates/reuses a project, projectId reuses one.");
        if (!isAbsolute(workspace)) throw new Error("workspace must be an absolute path.");
        const ws = canonical(workspace);
        if (!roots.length || !underRoots(ws, roots))
          throw new Error(roots.length ? `workspace is outside the allowed roots: ${roots.join(", ")}` : "this server only delegates into existing projects: pass projectId from lookout_list.");
        const existing = (await client.projects()).projects.find(p => canonical(p.workspace) === ws);
        if (existing) {
          pid = existing.id;
          projectModel = existing.model;
        } else {
          const created = (await client.createProject({
            name: basename(resolve(workspace)), workspace: ws,
            ...(settings.model ? { model: settings.model } : {}),
            ...(settings.effort ? { effort: settings.effort } : {}),
            ...(settings.mode ? { mode: settings.mode } : {}),
            ...(settings.multitask != null ? { multitask: settings.multitask } : {}),
          })).project;
          pid = created.id;
          projectModel = created.model;
        }
      }
      const briefed = prompt ? escapeMemoryShortcut(prompt) : undefined;
      const thread = (await client.createThread({
        projectId: pid,
        ...(briefed ? { text: briefed.text } : {}),
        ...(title ? { title } : {}),
        ...settings,
      })).thread;
      const out = {
        threadId: thread.id, projectId: pid, title: thread.title,
        hint: briefed
          ? "Poll lookout_check for progress; steer with lookout_steer on this thread id."
          : "Empty chat created (no turn). Send the first message with lookout_steer.",
        ...(briefed?.note ? { note: briefed.note } : {}),
      };
      if (settings.effort === undefined) return out;
      return {
        ...out,
        effortEcho: await effortEcho(client, settings.effort, thread.effort, settings.model ?? thread.model ?? projectModel, pid),
      };
    }));

  gate("lookout_check",
    "Poll a chat: live state, a one-line statusLine (working/needs-you/done + activity), the recent entries (bounded tail), todos, any pending question, background tasks. Poll ~30s; summaryOnly skips entry bodies; answer pendingQuestion via lookout_answer: a waiting chat makes no progress until you do.",
    {
      threadId: z.string().describe("From lookout_delegate (its threadId) or lookout_list."),
      tail: z.number().int().min(1).max(50).optional().describe("Entries to return, default 12. Older entries: pass beforeSeq. Ignored with summaryOnly."),
      afterSeq: z.number().int().min(0).optional().describe("Cursor: return only entries after this seq (the lastSeq of a previous check). Alias: sinceSeq."),
      sinceSeq: z.number().int().min(0).optional().describe("Alias for afterSeq."),
      beforeSeq: z.number().int().min(0).optional().describe("Return only entries before this seq (paging back). Combine with tail. Ignored with summaryOnly."),
      summaryOnly: z.boolean().optional().describe("Skip entry bodies: status snapshot only (live, statusLine, todos, pending question, last tool names, counts). Cheaper than a tailed check. Paging params are ignored; take lastSeq to a tailed check for bodies."),
      includeResults: z.boolean().optional().describe("Set false to drop tool result bodies from entries (calls stay). Default true."),
    },
    ({ threadId, tail, afterSeq, sinceSeq, beforeSeq, summaryOnly, includeResults }) => call(async () => {
      const d = await client.getThread(threadId);
      const after = afterSeq ?? sinceSeq;
      const statusLine = buildStatusLine(d);
      const lastSeq = d.entries.length ? d.entries[d.entries.length - 1]!.seq : 0;
      if (summaryOnly) {
        const tools = scanTools(d.entries);
        return {
          thread: camelThread(d.thread), live: d.live, lastStopReason: d.thread.last_stop_reason,
          statusLine, lastSeq,
          counts: { entries: d.entries.length, tools: tools.count },
          toolNames: tools.names,
          todos: d.todos, pendingQuestion: d.pendingQuestion, tasks: d.tasks, backgroundPending: d.backgroundPending,
        };
      }
      const render = (e: EntryOut) => ({ seq: e.seq, kind: e.kind, createdAt: e.created_at, payload: bound(includeResults === false ? stripResults(e.payload) : e.payload) });
      let n = tail ?? 12;
      for (;;) {
        const filtered = d.entries.filter(e =>
          (after === undefined || e.seq > after) && (beforeSeq === undefined || e.seq < beforeSeq));
        const entries = filtered.slice(-n);
        const firstShown = entries.length ? entries[0]!.seq : 0;
        const older = filtered.filter(e => e.seq < firstShown).length;
        const out = {
          thread: camelThread(d.thread), live: d.live, lastStopReason: d.thread.last_stop_reason,
          statusLine,
          entries: entries.map(render),
          lastSeq,
          older,
          olderHint: older > 0 ? `Pass beforeSeq: ${firstShown} with tail to page back over ${older} older entries.` : undefined,
          todos: d.todos, pendingQuestion: d.pendingQuestion, tasks: d.tasks, backgroundPending: d.backgroundPending,
        };
        // the whole result stays under the cap: shrink the tail before sending a context bomb
        if (JSON.stringify(out).length <= MAX_CHECK_BYTES || n <= 1) {
          return n < (tail ?? 12)
            ? { ...out, shrunk: `Tail shrunk to ${n} to stay under ${MAX_CHECK_BYTES} bytes; page with beforeSeq/afterSeq.` }
            : out;
        }
        n = Math.max(1, Math.floor(n / 2));
      }
    }));

  gate("lookout_steer", "Send a follow-up into a chat: queued steering mid-turn, or the next turn when idle. This is how you continue work: never a fresh delegate for follow-ups.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      text: z.string().min(1).max(1_000_000).describe("The follow-up, as a chat message."),
    },
    ({ threadId, text }) => call(async () => {
      const steered = escapeMemoryShortcut(text);
      const res = await client.sendMessage(threadId, steered.text);
      return steered.note ? { ...(res as Record<string, unknown>), note: steered.note } : res;
    }));

  gate("lookout_stop", "Stop a chat's turn and its background runs; queued steering is dropped and a pending question is skipped. The chat keeps everything it did.",
    { threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list.") },
    ({ threadId }) => call(async () => client.stop(threadId)));

  gate("lookout_rewind",
    "Edit & resend: truncate the transcript at the start of seq's turn and run text as the replacement. With restoreFiles the workspace also resets to the earliest checkpoint in the cut span. Poll lookout_check: a new turn is running.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      seq: z.number().int().min(1).describe("A user message seq from lookout_check: the turn holding it is cut."),
      text: z.string().min(1).max(1_000_000).describe("Replacement message to run on the kept prefix."),
      restoreFiles: z.boolean().optional().describe("Also reset workspace files to the cut span's earliest checkpoint."),
    },
    ({ threadId, seq, text, restoreFiles }) => call(async () => {
      const rewound = escapeMemoryShortcut(text);
      const res = await client.rewind(threadId, { seq, text: rewound.text, ...(restoreFiles ? { restoreFiles: true } : {}) });
      return rewound.note ? { ...res, note: rewound.note } : res;
    }));

  gate("lookout_restore",
    "Reset workspace files to a checkpoint this chat recorded (a turn entry's checkpoint in lookout_check), keeping the transcript. The todo list goes back too; memory stays.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      checkpoint: z.string().min(1).describe("A checkpoint sha from this chat's turn entries."),
    },
    ({ threadId, checkpoint }) => call(async () => client.restore(threadId, checkpoint)));

  gate("lookout_compact",
    "Compact a chat's context now (the composer's /compact): summarizes history into a bounded prefix. Refused while a turn runs; returns nothing to compact when the history is already small.",
    { threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list.") },
    ({ threadId }) => call(async () => client.compact(threadId)));

  gate("lookout_answer", "Answer the chat's pending AskQuestion (see lookout_check.pendingQuestion) so a waiting turn continues. Stale callIds are refused: re-check first.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      callId: z.string().optional().describe("Must match the pending question; omit only to answer whatever is pending."),
      answers: z.array(z.record(z.string(), z.unknown())).optional().describe("One answer per question, keyed as the question asks."),
      skip: z.boolean().optional().describe("Skip the question instead of answering."),
    },
    ({ threadId, callId, answers, skip }) => call(async () =>
      client.answers(threadId, { ...(callId ? { callId } : {}), ...(answers ? { answers } : {}), ...(skip ? { skip } : {}) })));

  gate("lookout_configure", "Retune a chat exactly like its header picker: model, effort, mode, multitask, title, or move it to another project, pin or archive it. A live turn finishes on the settings it started with. An explicit effort echoes what the model's ladder allowed.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      title: z.string().max(120).optional().describe("Chat title."),
      projectId: z.string().optional().describe("Move the chat to this project (an id from lookout_status). Refused while a turn or subagents run."),
      pinned: z.boolean().optional().describe("Pin to the top of its project's list."),
      archived: z.boolean().optional().describe("Archive out of the sidebar."),
      ...settingsShape,
    },
    ({ threadId, title, projectId, pinned, archived, ...settings }) => call(async () => {
      const thread = (await client.patchThread(threadId, {
        ...settings,
        ...(title ? { title } : {}),
        ...(projectId ? { projectId } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(archived !== undefined ? { archived } : {}),
      })).thread;
      if (settings.effort === undefined) return camelThread(thread);
      return {
        ...camelThread(thread),
        effortEcho: await effortEcho(client, settings.effort, thread.effort, settings.model ?? thread.model, thread.project_id),
      };
    }));

  gate("lookout_delete_thread", "Delete a chat and its transcript. A live turn is aborted; the workspace files are kept.",
    { threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list.") },
    ({ threadId }) => call(async () => client.deleteThread(threadId)));

  gate("lookout_tasks", "The chat's background Task runs: queued, running and finished, with steps and summaries.",
    { threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list.") },
    ({ threadId }) => call(async () => (await client.tasks(threadId)).tasks));

  gate("lookout_cancel_task", "Cancel one background run, or every run on the chat when taskId is omitted. (lookout_stop also cancels all.)",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      taskId: z.string().optional().describe("A run id from lookout_tasks; omit to cancel every run on the chat."),
    },
    ({ threadId, taskId }) => call(async () =>
      taskId ? client.cancelTask(threadId, taskId) : client.cancelTasks(threadId)));

  gate("lookout_task_transcript", "A background run's transcript (the in-app preview): its recent steps as JSONL text, bounded to a 24KB tail. The run's summary is in lookout_tasks/check.",
    {
      threadId: z.string().describe("The chat id: lookout_delegate's threadId, or a row from lookout_list."),
      taskId: z.string().describe("A run id from lookout_tasks."),
    },
    ({ threadId, taskId }) => call(async () => {
      const t = await client.taskTranscript(threadId, taskId);
      if (t.text.length <= MAX_TRANSCRIPT_CHARS) return t;
      const cut = t.text.length - MAX_TRANSCRIPT_CHARS;
      return {
        transcript: t.transcript,
        text: `…[truncated ${cut} head chars; showing the most recent ${MAX_TRANSCRIPT_CHARS}]\n${t.text.slice(cut)}`,
        truncated: true,
      };
    }));

  if (registered === 0) server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}
