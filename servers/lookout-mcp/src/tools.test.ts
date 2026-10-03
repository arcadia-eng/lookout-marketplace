// The MCP tool surface over HTTP, against a stubbed Lookout API: arg
// validation, roots gating, tail bounding, and method/path passthrough.
import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createMcpApp } from "./app";

const TOKEN = "operator-secret";
type Route = { status?: number; json: unknown };

function setup(routes: Record<string, Route>, roots: string[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ error: `stub: no ${key}` }), { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  const { app } = createMcpApp({ lookoutUrl: "http://lookout.test", publicUrl: "http://127.0.0.1:8792", token: TOKEN, originUrl: "https://accounts.test", bridgeToken: "", bridgeLabel: "test", roots, fetchFn });
  return { app, calls };
}

async function rpc(app: Hono, method: string, params?: unknown, token: string | null = TOKEN) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return res;
}

async function rpcJson(app: Hono, method: string, params?: unknown, token: string | null = TOKEN) {
  const res = await rpc(app, method, params, token);
  const text = await res.text();
  if (!res.ok) return { status: res.status, headers: res.headers, json: null as unknown };
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find(l => l.startsWith("data: "));
    return { status: res.status, headers: res.headers, json: JSON.parse(line!.slice(6)) as { result?: unknown; error?: unknown } };
  }
  return { status: res.status, headers: res.headers, json: JSON.parse(text) as { result?: unknown; error?: unknown } };
}

const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } };

async function tool(app: Hono, name: string, args: unknown) {
  const { json } = await rpcJson(app, "tools/call", { name, arguments: args });
  const result = (json as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { ...result, parsed: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

const THREAD = { id: "t1", project_id: "p1", title: "job", model: null, effort: null, mode: null, multitask: null, last_stop_reason: null, created_at: 1, updated_at: 2 };

describe("mcp transport", () => {
  test("initialize negotiates and tools/list names the surface", async () => {
    const { app } = setup({});
    const init = await rpcJson(app, "initialize", INIT);
    expect((init.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("lookout");
    // release gate: the advertised version is the package's, one literal pin
    expect((init.json as { result: { serverInfo: { version: string } } }).result.serverInfo.version).toBe("1.0.0");
    const list = await rpcJson(app, "tools/list", {});
    const names = ((list.json as { result: { tools: { name: string }[] } }).result.tools).map(t => t.name).sort();
    expect(names).toEqual([
      "lookout_answer", "lookout_cancel_task", "lookout_check", "lookout_compact",
      "lookout_configure", "lookout_configure_project", "lookout_create_project",
      "lookout_delegate", "lookout_delete_project", "lookout_delete_thread",
      "lookout_list", "lookout_models", "lookout_projects", "lookout_restore",
      "lookout_rewind", "lookout_status", "lookout_steer", "lookout_stop",
      "lookout_task_transcript", "lookout_tasks", "lookout_usage", "lookout_usage_local",
    ]);
  });

  test("/mcp without a bearer is 401 with resource metadata", async () => {
    const { app } = setup({});
    const res = await rpc(app, "tools/list", {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(".well-known/oauth-protected-resource");
  });

  test("unknown tool and bad args are tool errors, not transport errors", async () => {
    const { app } = setup({});
    const { json } = await rpcJson(app, "tools/call", { name: "nope", arguments: {} });
    expect((json as { result: { isError: boolean } }).result.isError).toBe(true);
    const bad = await rpcJson(app, "tools/call", { name: "lookout_check", arguments: {} });
    const badResult = (bad.json as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(badResult.isError).toBe(true); // zod rejects → isError naming threadId
    expect(badResult.content[0]!.text).toContain("threadId");
  });
});

describe("lookout_delegate", () => {
  const projects = (ws: string) => ({
    "GET /api/projects": { json: { projects: [{ id: "p1", name: "a", workspace: ws, model: "m", effort: "e", mode: "agent", multitask: false }] } },
  });

  test("reuses the project whose workspace matches, then creates and sends", async () => {
    const ws = "/tmp/roots/a";
    const { app, calls } = setup({
      ...projects(ws),
      "POST /api/threads": { json: { thread: THREAD } },
    }, ["/tmp/roots"]);
    const r = await tool(app, "lookout_delegate", { prompt: "do it", workspace: ws, title: "job" });
    expect(r.parsed.threadId).toBe("t1");
    expect(r.parsed.projectId).toBe("p1");
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /api/projects", "POST /api/threads"]);
    expect(calls[1]!.body).toMatchObject({ projectId: "p1", text: "do it", title: "job" });
  });

  test("creates a project for a new workspace under the roots", async () => {
    const { app, calls } = setup({
      "GET /api/projects": { json: { projects: [] } },
      "POST /api/projects": { json: { project: { id: "p9", workspace: "/tmp/roots/new" } } },
      "POST /api/threads": { json: { thread: { ...THREAD, project_id: "p9" } } },
    }, ["/tmp/roots"]);
    const r = await tool(app, "lookout_delegate", { prompt: "do it", workspace: "/tmp/roots/new", model: "m1", effort: "high", mode: "plan", multitask: true });
    expect(r.parsed).toMatchObject({ threadId: "t1", projectId: "p9" });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/api/projects" });
    expect(calls[1]!.body).toMatchObject({ model: "m1", effort: "high", mode: "plan", multitask: true });
  });

  test("projectId skips workspace resolution entirely", async () => {
    const { app, calls } = setup({ "POST /api/threads": { json: { thread: THREAD } } });
    const r = await tool(app, "lookout_delegate", { prompt: "again", projectId: "p1" });
    expect(r.parsed.threadId).toBe("t1");
    expect(calls.map(c => c.path)).toEqual(["/api/threads"]);
  });

  test("omitted prompt creates an empty chat (no text sent)", async () => {
    const { app, calls } = setup({ "POST /api/threads": { json: { thread: THREAD } } });
    const r = await tool(app, "lookout_delegate", { projectId: "p1", title: "empty" });
    expect(r.isError).toBeFalsy();
    expect(r.parsed.threadId).toBe("t1");
    expect(r.parsed.hint).toContain("Empty chat");
    expect(calls[0]!.body).toMatchObject({ projectId: "p1", title: "empty" });
    expect(calls[0]!.body).not.toHaveProperty("text");
  });

  test("refuses: neither target, relative path, outside roots", async () => {
    const { app } = setup({}, ["/tmp/roots"]);
    for (const args of [{ prompt: "x" }, { prompt: "x", workspace: "rel/path" }, { prompt: "x", workspace: "/elsewhere" }]) {
      const r = await tool(app, "lookout_delegate", args);
      expect(r.isError).toBe(true);
    }
  });

  test("no roots configured: workspace delegates are refused, projectId works", async () => {
    const { app } = setup({ "POST /api/threads": { json: { thread: THREAD } } });
    const bad = await tool(app, "lookout_delegate", { prompt: "x", workspace: "/tmp/anywhere" });
    expect(bad.isError).toBe(true);
    expect(bad.parsed.error).toContain("projectId");
    const good = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1" });
    expect(good.parsed.threadId).toBe("t1");
  });

  test("a leading # is escaped and noted, never a silent memory write", async () => {
    const { app, calls } = setup({
      "POST /api/threads": { json: { thread: THREAD } },
      "POST /api/threads/t1/messages": { json: { ok: true } },
    });
    const d = await tool(app, "lookout_delegate", { prompt: "## Task\nDo it.", projectId: "p1" });
    expect(d.parsed.note).toContain("memory write");
    expect(calls[0]!.body).toMatchObject({ text: "\u200b## Task\nDo it." });
    const s = await tool(app, "lookout_steer", { threadId: "t1", text: "# remember this" });
    expect(s.parsed.note).toContain("memory write");
    expect(calls[1]!.body).toMatchObject({ text: "\u200b# remember this" });
  });

  test("a Lookout error (unknown model) surfaces as a tool error", async () => {
    const { app } = setup({ "POST /api/threads": { status: 400, json: { error: 'unknown model "m9"' } } });
    const r = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1", model: "m9" });
    expect(r.isError).toBe(true);
    expect(r.parsed.error).toContain('unknown model "m9"');
  });
});

describe("lookout_check", () => {
  const detail = {
    thread: THREAD, todos: [], live: true, pendingQuestion: { callId: "q1", title: "pick", questions: [{ id: "a" }] },
    tasks: [], backgroundPending: 0,
    entries: [
      { id: "e1", thread_id: "t1", seq: 1, kind: "user", payload: { text: "hi" }, created_at: 1 },
      { id: "e2", thread_id: "t1", seq: 2, kind: "turn", payload: { text: "x".repeat(5000) }, created_at: 2 },
      { id: "e3", thread_id: "t1", seq: 3, kind: "item", payload: { items: Array.from({ length: 40 }, (_, i) => i) }, created_at: 3 },
    ],
  };

  test("bounds the tail and marks every cut", async () => {
    const { app } = setup({ "GET /api/threads/t1": { json: detail } });
    const r = await tool(app, "lookout_check", { threadId: "t1" });
    expect(r.parsed.live).toBe(true);
    expect(r.parsed.pendingQuestion).toMatchObject({ callId: "q1" });
    const entries = r.parsed.entries as { seq: number; payload: Record<string, unknown> }[];
    expect(entries.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(entries[1]!.payload.text as string).toContain("…[truncated 3000 chars]");
    expect(entries[2]!.payload.items as unknown[]).toHaveLength(31);
    expect(r.parsed.lastSeq).toBe(3);
    expect(r.parsed.older).toBe(0);
  });

  test("afterSeq pages and older/olderHint name the rest", async () => {
    const { app } = setup({ "GET /api/threads/t1": { json: detail } });
    const r = await tool(app, "lookout_check", { threadId: "t1", tail: 1, afterSeq: 1 });
    expect((r.parsed.entries as { seq: number }[]).map(e => e.seq)).toEqual([3]);
    expect(r.parsed.older).toBe(1);
    expect(r.parsed.olderHint).toContain("beforeSeq: 3");
  });

  test("beforeSeq pages back over exactly the older entries", async () => {
    const { app } = setup({ "GET /api/threads/t1": { json: detail } });
    const first = await tool(app, "lookout_check", { threadId: "t1", tail: 1 });
    expect((first.parsed.entries as { seq: number }[]).map(e => e.seq)).toEqual([3]);
    const back = await tool(app, "lookout_check", { threadId: "t1", tail: 5, beforeSeq: 3 });
    expect((back.parsed.entries as { seq: number }[]).map(e => e.seq)).toEqual([1, 2]);
    expect(back.parsed.older).toBe(0);
    expect(back.parsed.olderHint).toBeUndefined();
  });

  test("an oversized tail shrinks itself and says so", async () => {
    const big = {
      ...detail,
      entries: Array.from({ length: 50 }, (_, i) => ({
        id: `e${i}`, thread_id: "t1", seq: i + 1, kind: "turn", payload: { text: "y".repeat(2000) }, created_at: i,
      })),
    };
    const { app } = setup({ "GET /api/threads/t1": { json: big } });
    const r = await tool(app, "lookout_check", { threadId: "t1", tail: 50 });
    expect(r.parsed.shrunk).toContain("shrunk to");
    expect(JSON.stringify(r.parsed).length).toBeLessThan(48_000 + 5_000);
    expect((r.parsed.entries as unknown[]).length).toBeLessThan(50);
  });
});

describe("passthrough tools", () => {
  test("steer/stop/answer/configure/tasks/cancel/delete/rewind/restore/compact hit their routes", async () => {
    const { app, calls } = setup({
      "POST /api/threads/t1/messages": { json: { queued: true } },
      "POST /api/threads/t1/stop": { json: { ok: true, dropped: [] } },
      "POST /api/threads/t1/answers": { json: { ok: true } },
      "PATCH /api/threads/t1": { json: { thread: { ...THREAD, mode: "plan" } } },
      "GET /api/threads/t1/tasks": { json: { tasks: [{ id: "k1" }] } },
      "POST /api/threads/t1/tasks/k1/cancel": { json: { ok: true } },
      "POST /api/threads/t1/tasks/cancel": { json: { ok: true, cancelled: 2 } },
      "DELETE /api/threads/t1": { json: { ok: true } },
      "POST /api/threads/t1/rewind": { json: { ok: true } },
      "POST /api/threads/t1/restore": { json: { ok: true } },
      "POST /api/threads/t1/compact": { json: { ok: true, before: 10, after: 5 } },
    });
    await tool(app, "lookout_steer", { threadId: "t1", text: "pivot" });
    await tool(app, "lookout_stop", { threadId: "t1" });
    await tool(app, "lookout_answer", { threadId: "t1", callId: "q1", answers: [{ a: 1 }] });
    await tool(app, "lookout_configure", { threadId: "t1", mode: "plan", multitask: true });
    await tool(app, "lookout_configure", { threadId: "t1", projectId: "p2", pinned: true, archived: false });
    await tool(app, "lookout_tasks", { threadId: "t1" });
    await tool(app, "lookout_cancel_task", { threadId: "t1", taskId: "k1" });
    await tool(app, "lookout_cancel_task", { threadId: "t1" });
    await tool(app, "lookout_delete_thread", { threadId: "t1" });
    await tool(app, "lookout_rewind", { threadId: "t1", seq: 3, text: "try again", restoreFiles: true });
    await tool(app, "lookout_restore", { threadId: "t1", checkpoint: "abc123" });
    await tool(app, "lookout_compact", { threadId: "t1" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/threads/t1/messages", body: { text: "pivot" } },
      { method: "POST", path: "/api/threads/t1/stop", body: {} },
      { method: "POST", path: "/api/threads/t1/answers", body: { callId: "q1", answers: [{ a: 1 }] } },
      { method: "PATCH", path: "/api/threads/t1", body: { mode: "plan", multitask: true } },
      { method: "PATCH", path: "/api/threads/t1", body: { projectId: "p2", pinned: true, archived: false } },
      { method: "GET", path: "/api/threads/t1/tasks", body: undefined },
      { method: "POST", path: "/api/threads/t1/tasks/k1/cancel", body: {} },
      { method: "POST", path: "/api/threads/t1/tasks/cancel", body: {} },
      { method: "DELETE", path: "/api/threads/t1", body: undefined },
      { method: "POST", path: "/api/threads/t1/rewind", body: { seq: 3, text: "try again", restoreFiles: true } },
      { method: "POST", path: "/api/threads/t1/restore", body: { checkpoint: "abc123" } },
      { method: "POST", path: "/api/threads/t1/compact", body: {} },
    ]);
  });

  test("rewind escapes a leading # and refuses bad seq; restore/compact surface server errors", async () => {
    const { app, calls } = setup({
      "POST /api/threads/t1/rewind": { json: { ok: true } },
      "POST /api/threads/t1/restore": { status: 400, json: { error: "unknown checkpoint" } },
      "POST /api/threads/t1/compact": { status: 409, json: { error: "turn in progress" } },
    });
    const r = await tool(app, "lookout_rewind", { threadId: "t1", seq: 1, text: "# retry" });
    expect(r.parsed.note).toContain("memory write");
    expect(calls[0]!.body).toMatchObject({ text: "\u200b# retry" });
    // zod rejects seq: 0 (the SDK's plain-text error, not our JSON fail())
    const { json } = await rpcJson(app, "tools/call", { name: "lookout_rewind", arguments: { threadId: "t1", seq: 0, text: "x" } });
    const bad = (json as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("seq");
    const restore = await tool(app, "lookout_restore", { threadId: "t1", checkpoint: "nope" });
    expect(restore.isError).toBe(true);
    expect(restore.parsed.error).toContain("unknown checkpoint");
    const compact = await tool(app, "lookout_compact", { threadId: "t1" });
    expect(compact.isError).toBe(true);
    expect(compact.parsed.error).toContain("turn in progress");
  });

  test("stale answers surface the 409", async () => {
    const { app } = setup({ "POST /api/threads/t1/answers": { status: 409, json: { error: "stale answer" } } });
    const r = await tool(app, "lookout_answer", { threadId: "t1", callId: "old" });
    expect(r.isError).toBe(true);
    expect(r.parsed.error).toContain("stale answer");
  });

  test("status/models/usage/list shape their reads", async () => {
    const { app } = setup({
      "GET /api/health": { json: { busy: false, memoryPending: 0 } },
      "GET /api/models": { json: { data: [{ id: "m1", label: "M", provider: "p", efforts: ["high"] }] } },
      "GET /api/projects": { json: { projects: [{ id: "p1", name: "a", workspace: "/w", model: "m", effort: "e", mode: "agent", multitask: false }] } },
      "GET /api/projects/p1/threads": { json: { threads: [THREAD] } },
      "GET /api/providers/muse/usage": { json: { window: 1 } },
      "GET /api/providers/zai/usage": { json: { window: 2 } },
      "GET /api/providers/chatgpt/usage": { json: { window: 3 } },
      "GET /api/providers/devin/status": { json: { seat: true } },
    });
    const s = await tool(app, "lookout_status", {});
    expect(s.parsed).toMatchObject({ busy: false, models: [{ id: "m1" }] });
    expect(s.parsed.usage).toMatchObject({ muse: { window: 1 }, devin: { seat: true } });
    expect(s.parsed.threads).toHaveLength(1);
    const m = await tool(app, "lookout_models", {});
    expect(m.parsed).toHaveLength(1);
    const u = await tool(app, "lookout_usage", { provider: "zai" });
    expect(u.parsed).toEqual({ window: 2 });
    const l = await tool(app, "lookout_list", { limit: 5 });
    expect(l.parsed).toHaveLength(1);
  });

  test("task_transcript passes through small runs, bounds large ones to a marked tail", async () => {
    const { app, calls } = setup({
      "GET /api/threads/t1/tasks/k1/transcript": { json: { transcript: "/w/t.jsonl", text: "short", truncated: false } },
    });
    const small = await tool(app, "lookout_task_transcript", { threadId: "t1", taskId: "k1" });
    expect(small.parsed).toEqual({ transcript: "/w/t.jsonl", text: "short", truncated: false });
    expect(calls).toEqual([{ method: "GET", path: "/api/threads/t1/tasks/k1/transcript", body: undefined }]);

    const big = setup({
      "GET /api/threads/t1/tasks/k2/transcript": { json: { transcript: "/w/t.jsonl", text: `HEAD${"x".repeat(30_000)}TAIL`, truncated: false } },
    });
    const bounded = await tool(big.app, "lookout_task_transcript", { threadId: "t1", taskId: "k2" });
    expect(bounded.parsed.truncated).toBe(true);
    const text = bounded.parsed.text as string;
    expect(text).toContain("…[truncated ");
    expect(text).toContain("TAIL");
    expect(text).not.toContain("HEAD");
    expect(text.length).toBeLessThan(24_000 + 200);

    const missing = setup({ "GET /api/threads/t1/tasks/nope/transcript": { status: 404, json: { error: "no such task" } } });
    const m = await tool(missing.app, "lookout_task_transcript", { threadId: "t1", taskId: "nope" });
    expect(m.isError).toBe(true);
    expect(m.parsed.error).toContain("no such task");
  });

  test("usage_local slices the newest turns, keeps full totals, marks the spill", async () => {
    const reqs = Array.from({ length: 5 }, (_, i) => ({ at: i, model: "m" }));
    const { app, calls } = setup({
      "GET /api/usage/local": { json: { requests: reqs, totals: { requests: 5, totalTokens: 100 } } },
    });
    const r = await tool(app, "lookout_usage_local", { days: 7, limit: 2 });
    expect(r.parsed).toMatchObject({ totals: { requests: 5 }, showing: 2, total: 5 });
    expect(r.parsed.requests).toHaveLength(2);
    expect(r.parsed.spilled).toContain("newest 2 of 5");
    expect(calls[0]!.path).toBe("/api/usage/local");
    const full = await tool(app, "lookout_usage_local", {});
    expect(full.parsed).toMatchObject({ showing: 5, total: 5 });
    expect(full.parsed.spilled).toBeUndefined();
  });
});

describe("project tools", () => {
  const PROJECT = { id: "p1", name: "a", description: "", model: "m", effort: "e", mode: "agent", multitask: false, workspace: "/tmp/roots/a", created_at: 1, updated_at: 2 };

  test("projects lists all or one by id", async () => {
    const { app } = setup({ "GET /api/projects": { json: { projects: [PROJECT, { ...PROJECT, id: "p2" }] } } });
    const all = await tool(app, "lookout_projects", {});
    expect(all.parsed).toHaveLength(2);
    const one = await tool(app, "lookout_projects", { projectId: "p2" });
    expect(one.parsed).toMatchObject({ id: "p2" });
    const missing = await tool(app, "lookout_projects", { projectId: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.parsed.error).toContain("unknown project");
  });

  test("create/configure/delete hit their routes", async () => {
    const { app, calls } = setup({
      "POST /api/projects": { json: { project: PROJECT } },
      "PATCH /api/projects/p1": { json: { project: { ...PROJECT, name: "b" } } },
      "DELETE /api/projects/p1": { json: { ok: true } },
    }, ["/private/tmp/roots"]);
    await tool(app, "lookout_create_project", { workspace: "/private/tmp/roots/a", description: "d", model: "m1", multitask: true });
    await tool(app, "lookout_configure_project", { projectId: "p1", name: "b", mode: "plan" });
    await tool(app, "lookout_delete_project", { projectId: "p1" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/projects", body: { workspace: "/private/tmp/roots/a", name: "a", description: "d", model: "m1", multitask: true } },
      { method: "PATCH", path: "/api/projects/p1", body: { name: "b", mode: "plan" } },
      { method: "DELETE", path: "/api/projects/p1", body: undefined },
    ]);
  });

  test("create gates workspaces under roots, allows scratch without them", async () => {
    const { app, calls } = setup({ "POST /api/projects": { json: { project: PROJECT } } }, ["/tmp/roots"]);
    for (const args of [{ workspace: "rel/path" }, { workspace: "/elsewhere" }]) {
      const r = await tool(app, "lookout_create_project", args);
      expect(r.isError).toBe(true);
    }
    const scratch = await tool(app, "lookout_create_project", { scratch: true, name: "s" });
    expect(scratch.isError).toBeFalsy();
    expect(calls.at(-1)!.body).toMatchObject({ name: "s", scratch: true });

    const noroot = setup({ "POST /api/projects": { json: { project: PROJECT } } });
    const refused = await tool(noroot.app, "lookout_create_project", { workspace: "/tmp/anywhere" });
    expect(refused.isError).toBe(true);
    expect(refused.parsed.error).toContain("scratch");
    const allowed = await tool(noroot.app, "lookout_create_project", { scratch: true });
    expect(allowed.isError).toBeFalsy();
  });

  test("a Lookout error (name taken) surfaces as a tool error", async () => {
    const { app } = setup({ "PATCH /api/projects/p1": { status: 409, json: { error: "name already taken" } } });
    const r = await tool(app, "lookout_configure_project", { projectId: "p1", name: "a" });
    expect(r.isError).toBe(true);
    expect(r.parsed.error).toContain("name already taken");
  });
});

describe("effort echo", () => {
  const LADDER = ["minimal", "low", "medium", "high", "xhigh"];
  const MODELS = [{ id: "muse-spark-1.3", label: "Spark 1.3", provider: "muse", owned_by: "Muse", efforts: LADDER, defaultEffort: "high" }];

  test("delegate: a clamped level echoes requested/applied plus the allowed ladder", async () => {
    const { app, calls } = setup({
      "POST /api/threads": { json: { thread: { ...THREAD, model: "muse-spark-1.3", effort: "xhigh" } } },
      "GET /api/models": { json: { data: MODELS } },
    });
    const r = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1", model: "muse-spark-1.3", effort: "max" });
    expect(r.isError).toBeFalsy();
    expect(r.parsed.effortEcho).toEqual({ requested: "max", applied: "xhigh", allowed: LADDER });
    expect(calls.map(c => c.path)).toContain("/api/models");
  });

  test("delegate: an exact level echoes without the ladder and without extra reads", async () => {
    const { app, calls } = setup({
      "POST /api/threads": { json: { thread: { ...THREAD, model: "muse-spark-1.3", effort: "high" } } },
    });
    const r = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1", model: "muse-spark-1.3", effort: "high" });
    expect(r.parsed.effortEcho).toEqual({ requested: "high", applied: "high" });
    expect(calls.map(c => c.path)).toEqual(["/api/threads"]);
  });

  test("delegate: no effort passed means no echo", async () => {
    const { app } = setup({ "POST /api/threads": { json: { thread: THREAD } } });
    const r = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1", model: "muse-spark-1.3" });
    expect(r.parsed).not.toHaveProperty("effortEcho");
  });

  test("delegate: without an explicit model the project resolves the ladder", async () => {
    const { app } = setup({
      "POST /api/threads": { json: { thread: { ...THREAD, model: null, effort: "xhigh" } } },
      "GET /api/projects": { json: { projects: [{ id: "p1", model: "muse-spark-1.3" }] } },
      "GET /api/models": { json: { data: MODELS } },
    });
    const r = await tool(app, "lookout_delegate", { prompt: "x", projectId: "p1", effort: "max" });
    expect(r.parsed.effortEcho).toEqual({ requested: "max", applied: "xhigh", allowed: LADDER });
  });

  test("configure and configure_project echo a clamp the same way", async () => {
    const { app } = setup({
      "PATCH /api/threads/t1": { json: { thread: { ...THREAD, model: "muse-spark-1.3", effort: "xhigh" } } },
      "PATCH /api/projects/p1": { json: { project: { id: "p1", model: "muse-spark-1.3", effort: "xhigh" } } },
      "GET /api/models": { json: { data: MODELS } },
    });
    const c = await tool(app, "lookout_configure", { threadId: "t1", effort: "max" });
    expect(c.parsed.effortEcho).toEqual({ requested: "max", applied: "xhigh", allowed: LADDER });
    expect(c.parsed).toMatchObject({ projectId: "p1", effort: "xhigh" });
    const p = await tool(app, "lookout_configure_project", { projectId: "p1", effort: "max" });
    expect(p.parsed.effortEcho).toEqual({ requested: "max", applied: "xhigh", allowed: LADDER });
    const plain = await tool(app, "lookout_configure", { threadId: "t1", mode: "plan" });
    expect(plain.parsed).not.toHaveProperty("effortEcho");
  });
});

describe("naming", () => {
  const noSnake = (o: unknown) =>
    expect(Object.keys(o as Record<string, unknown>).filter(k => k.includes("_"))).toEqual([]);

  test("tools/list: all 22 tools carry full inputSchema with camelCase params", async () => {
    const { app } = setup({});
    const { json } = await rpcJson(app, "tools/list", {});
    const tools = (json as { result: { tools: { name: string; inputSchema: { type: string; properties?: Record<string, unknown> } }[] } }).result.tools;
    expect(tools).toHaveLength(22);
    for (const t of tools) {
      expect(t.inputSchema?.type).toBe("object");
      for (const p of Object.keys(t.inputSchema?.properties ?? {})) expect(p).not.toContain("_");
    }
  });

  test("status/check/list/configure payloads use camelCase ids; payload bodies keep engine vocabulary", async () => {
    const detail = {
      thread: THREAD, todos: [], live: true, pendingQuestion: null, tasks: [], backgroundPending: 0,
      entries: [{
        id: "e1", thread_id: "t1", seq: 1, kind: "item",
        payload: { item: { type: "response", id: "r1", parts: [{ type: "call", id: "c1", name: "StrReplace", args: JSON.stringify({ path: "/w/a", old_string: "a", new_string: "b" }) }] } },
        created_at: 1,
      }],
    };
    const { app } = setup({
      "GET /api/health": { json: { busy: false, memoryPending: 0 } },
      "GET /api/models": { json: { data: [{ id: "m1", label: "M", provider: "p", owned_by: "P", efforts: ["high"] }] } },
      "GET /api/projects": { json: { projects: [{ id: "p1", name: "a", workspace: "/w", model: "m", effort: "e", mode: "agent", multitask: false, created_at: 1, updated_at: 2 }] } },
      "GET /api/projects/p1/threads": { json: { threads: [THREAD] } },
      "GET /api/providers/muse/usage": { json: {} },
      "GET /api/providers/zai/usage": { json: {} },
      "GET /api/providers/chatgpt/usage": { json: {} },
      "GET /api/providers/devin/status": { json: {} },
      "GET /api/threads/t1": { json: detail },
      "PATCH /api/threads/t1": { json: { thread: THREAD } },
      "POST /api/projects": { json: { project: { id: "p1", workspace: "/w", created_at: 1, updated_at: 2 } } },
      "PATCH /api/projects/p1": { json: { project: { id: "p1", workspace: "/w", created_at: 1, updated_at: 2 } } },
    });
    const s = await tool(app, "lookout_status", {});
    noSnake((s.parsed.projects as unknown[])[0]);
    noSnake((s.parsed.threads as unknown[])[0]);
    expect((s.parsed.threads as { projectId: string }[])[0]!.projectId).toBe("p1");

    const c = await tool(app, "lookout_check", { threadId: "t1" });
    noSnake(c.parsed.thread);
    expect(c.parsed.thread).toMatchObject({ projectId: "p1" });
    const entry = (c.parsed.entries as Record<string, unknown>[])[0]!;
    noSnake(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "payload")));
    // the boundary: tool args inside payload keep the engine's own spelling
    expect(JSON.stringify(entry.payload)).toContain("old_string");

    const l = await tool(app, "lookout_list", {});
    const row = (l.parsed as unknown as Record<string, unknown>[])[0]!;
    noSnake(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "project")));
    expect(row).toMatchObject({ projectId: "p1" });

    const m = await tool(app, "lookout_models", {});
    const rows = m.parsed as unknown as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ ownedBy: "P" });
    expect(rows[0]).not.toHaveProperty("owned_by");

    const cfg = await tool(app, "lookout_configure", { threadId: "t1", mode: "plan" });
    noSnake(cfg.parsed);
    const created = await tool(app, "lookout_create_project", { scratch: true });
    noSnake(Object.fromEntries(Object.entries(created.parsed).filter(([k]) => k !== "hint")));
    const cfgp = await tool(app, "lookout_configure_project", { projectId: "p1", mode: "plan" });
    noSnake(cfgp.parsed);
  });
});

describe("lookout_check payload", () => {
  const response = (id: string, name: string, args: unknown) => ({
    type: "response", id, producer: { provider: "m", model: "m", wireModel: "m" },
    parts: [{ type: "call", id, name, args: JSON.stringify(args) }],
    finish: { reason: "calls" }, request: { lane: "chat", toolChoice: "auto" },
  });
  const result = (callId: string, name: string, text: string) => ({
    type: "result", id: `r-${callId}`, callId, name, status: "ok", parts: [{ type: "text", text }],
  });
  const item = (seq: number, it: unknown) => ({ id: `e${seq}`, thread_id: "t1", seq, kind: "item", payload: { item: it }, created_at: seq });
  const detailFor = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    thread: THREAD, todos: [], live: true, pendingQuestion: null, tasks: [], backgroundPending: 0, entries, ...extra,
  });

  test("summaryOnly: status snapshot without entry bodies, byte-bounded", async () => {
    const entries = [
      { id: "e0", thread_id: "t1", seq: 1, kind: "user", payload: { text: "build it" }, created_at: 0 },
      item(2, response("c1", "StrReplace", { path: "/w/index.html" })),
      item(3, result("c1", "StrReplace", "y".repeat(2000))),
      ...Array.from({ length: 49 }, (_, i) => item(4 + i, result(`x${i}`, i % 2 ? "Shell" : "Read", "z".repeat(2000)))),
    ];
    const { app } = setup({ "GET /api/threads/t1": { json: detailFor(entries) } });
    const r = await tool(app, "lookout_check", { threadId: "t1", summaryOnly: true });
    expect(r.isError).toBeFalsy();
    expect(r.parsed).not.toHaveProperty("entries");
    expect(r.parsed).toMatchObject({ live: true, lastSeq: 52, counts: { entries: 52, tools: 50 } });
    expect(r.parsed.toolNames).toHaveLength(10);
    expect(r.parsed.toolNames).toContain("Shell");
    expect(typeof r.parsed.statusLine).toBe("string");
    expect(JSON.stringify(r.parsed).length).toBeLessThan(8000);
  });

  test("includeResults:false drops result blobs, keeps calls; the default keeps bodies", async () => {
    const entries = [
      item(1, response("c1", "Read", { path: "/w/a" })),
      item(2, result("c1", "Read", "BODY".repeat(1000))),
    ];
    const { app } = setup({ "GET /api/threads/t1": { json: detailFor(entries) } });
    const slim = await tool(app, "lookout_check", { threadId: "t1", includeResults: false });
    const slimEntries = slim.parsed.entries as { payload: { item: { type: string; parts: { text?: string }[] } } }[];
    expect(slimEntries[0]!.payload.item.parts[0]).toMatchObject({ type: "call", name: "Read" });
    expect(slimEntries[1]!.payload.item).toMatchObject({ type: "result", name: "Read", status: "ok" });
    expect(slimEntries[1]!.payload.item.parts).toHaveLength(1);
    expect(slimEntries[1]!.payload.item.parts[0]!.text).toContain("includeResults");
    expect(JSON.stringify(slim.parsed)).not.toContain("BODYBODY");
    const full = await tool(app, "lookout_check", { threadId: "t1" });
    expect(JSON.stringify(full.parsed)).toContain("BODYBODY");
  });

  test("sinceSeq aliases afterSeq", async () => {
    const entries = [1, 2, 3].map(seq => ({ id: `e${seq}`, thread_id: "t1", seq, kind: "user", payload: { text: `m${seq}` }, created_at: seq }));
    const { app } = setup({ "GET /api/threads/t1": { json: detailFor(entries) } });
    const a = await tool(app, "lookout_check", { threadId: "t1", afterSeq: 2 });
    const b = await tool(app, "lookout_check", { threadId: "t1", sinceSeq: 2 });
    expect((a.parsed.entries as { seq: number }[]).map(e => e.seq)).toEqual([3]);
    expect((b.parsed.entries as { seq: number }[]).map(e => e.seq)).toEqual([3]);
  });
});

describe("statusLine", () => {
  const response = (id: string, name: string, args: unknown) => ({
    type: "response", id, producer: { provider: "m", model: "m", wireModel: "m" },
    parts: [{ type: "call", id, name, args: JSON.stringify(args) }],
    finish: { reason: "calls" }, request: { lane: "chat", toolChoice: "auto" },
  });
  const result = (callId: string, name: string) => ({
    type: "result", id: `r-${callId}`, callId, name, status: "ok", parts: [{ type: "text", text: "ok" }],
  });
  const item = (seq: number, it: unknown) => ({ id: `e${seq}`, thread_id: "t1", seq, kind: "item", payload: { item: it }, created_at: seq });
  const user = (seq: number) => ({ id: `e${seq}`, thread_id: "t1", seq, kind: "user", payload: { text: "hi" }, created_at: seq });
  const detailFor = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    thread: THREAD, todos: [], live: true, pendingQuestion: null, tasks: [], backgroundPending: 0, entries, ...extra,
  });
  const line = async (entries: unknown[], extra: Record<string, unknown> = {}) => {
    const { app } = setup({ "GET /api/threads/t1": { json: detailFor(entries, extra) } });
    return (await tool(app, "lookout_check", { threadId: "t1" })).parsed.statusLine as string;
  };

  test("live with an in-flight tool names the activity", async () => {
    expect(await line([user(1), item(2, response("c1", "StrReplace", { path: "/w/index.html" }))]))
      .toBe("working · editing index.html · StrReplace #2");
  });

  test("live with settled tools plans next moves", async () => {
    expect(await line([user(1), item(2, response("c1", "Read", { path: "/w/a" })), item(3, result("c1", "Read"))]))
      .toBe("working · planning next moves");
  });

  test("a pending question outranks live", async () => {
    expect(await line(
      [user(1), item(2, response("c1", "Shell", { command: "sleep 99" }))],
      { pendingQuestion: { callId: "q1", title: "pick one", questions: [] } },
    )).toBe("needs-you · pick one");
  });

  test("idle reads done with the stop reason; an empty chat reads done/idle", async () => {
    expect(await line([user(1)], { live: false, thread: { ...THREAD, last_stop_reason: "stop" } })).toBe("done · stop");
    expect(await line([], { live: false, thread: { ...THREAD, last_stop_reason: null } })).toBe("done · idle");
  });

  test("running background tasks read working", async () => {
    expect(await line([user(1)], { live: false, tasks: [{ id: "k1", status: "running" }] }))
      .toBe("working · background tasks running (1)");
  });

  test("summaryOnly carries the same statusLine", async () => {
    const { app } = setup({ "GET /api/threads/t1": { json: detailFor([user(1)], { live: false, thread: { ...THREAD, last_stop_reason: "error" } }) } });
    const full = await tool(app, "lookout_check", { threadId: "t1" });
    const slim = await tool(app, "lookout_check", { threadId: "t1", summaryOnly: true });
    expect(full.parsed.statusLine).toBe("done · error");
    expect(slim.parsed.statusLine).toBe("done · error");
  });
});

describe("delegate one-shot", () => {
  test("cold start: one delegate from empty state does project+chat+prompt", async () => {
    const { app, calls } = setup({
      "GET /api/projects": { json: { projects: [] } },
      "POST /api/projects": { json: { project: { id: "p9", workspace: "/tmp/roots/new" } } },
      "POST /api/threads": { json: { thread: THREAD } },
    }, ["/tmp/roots"]);
    const r = await tool(app, "lookout_delegate", { prompt: "do it", workspace: "/tmp/roots/new" });
    expect(r.isError).toBeFalsy();
    expect(r.parsed).toMatchObject({ threadId: "t1", projectId: "p9" });
    expect(r.parsed.hint).toContain("lookout_check");
    expect(r.parsed).not.toHaveProperty("effortEcho");
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /api/projects", "POST /api/projects", "POST /api/threads"]);
    expect(calls[1]!.body).toMatchObject({ name: "new" });
    expect((calls[1]!.body as { workspace: string }).workspace).toContain("roots/new");
  });

  test("create_project points at delegate for work", async () => {
    const { app } = setup({ "POST /api/projects": { json: { project: { id: "p1", workspace: "/w" } } } });
    const r = await tool(app, "lookout_create_project", { scratch: true });
    expect(r.parsed.hint).toContain("lookout_delegate");
  });

  test("delegate's description leads with the one-call happy path", async () => {
    const { app } = setup({});
    const { json } = await rpcJson(app, "tools/list", {});
    const tools = (json as { result: { tools: { name: string; description: string }[] } }).result.tools;
    const delegate = tools.find(t => t.name === "lookout_delegate")!;
    expect(delegate.description).toContain("ONE call");
    const create = tools.find(t => t.name === "lookout_create_project")!;
    expect(create.description).toContain("lookout_delegate");
  });
});
