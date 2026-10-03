// Loopback client for the Lookout HTTP API. The MCP server is a separate
// process and an ordinary local non-browser client: every request carries
// X-Lookout-Client so the server's DNS-rebinding guard admits it, and
// state-changing requests send JSON bodies.
// Contract with the Lookout server's guard (src/server/guard.ts in the
// Lookout monorepo): the header name is "x-lookout-client", pinned by the
// Lookout-side contract suite (src/mcp-contract) against this package.
const CLIENT_HEADER = "x-lookout-client";

export class LookoutError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "LookoutError";
  }
}

export interface ThreadSettings {
  model?: string;
  effort?: string;
  mode?: string;
  multitask?: boolean | null;
}

export interface ThreadOut {
  id: string;
  project_id: string;
  title: string;
  model: string | null;
  effort: string | null;
  mode: string | null;
  multitask: boolean | null;
  last_stop_reason: string | null;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface ProjectOut {
  id: string;
  name: string;
  description: string;
  model: string;
  effort: string;
  mode: string;
  multitask: boolean;
  workspace: string;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface EntryOut {
  id: string;
  thread_id: string;
  seq: number;
  kind: string;
  payload: unknown;
  created_at: number;
}

export interface ThreadDetail {
  thread: ThreadOut;
  entries: EntryOut[];
  todos: unknown;
  live: boolean;
  pendingQuestion: null | {
    callId: string;
    title: string;
    questions: unknown;
    expiresAt?: number;
  };
  tasks: unknown[];
  backgroundPending: number;
}

export interface ModelRow {
  id: string;
  label: string;
  provider: string;
  efforts: string[];
  defaultEffort?: string;
  [k: string]: unknown;
}

export type FetchFn = typeof fetch;

export class LookoutClient {
  constructor(
    private baseUrl: string,
    private fetchFn: FetchFn = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [CLIENT_HEADER]: "mcp",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new LookoutError(res.status, data?.error ?? `lookout ${method} ${path}: ${res.status}`);
    return data as T;
  }

  health(): Promise<{ busy: boolean; memoryPending: number }> {
    return this.req("GET", "/api/health");
  }

  models(all = false): Promise<{ data: ModelRow[] }> {
    return this.req("GET", all ? "/api/models?all=1" : "/api/models");
  }

  projects(): Promise<{ projects: ProjectOut[] }> {
    return this.req("GET", "/api/projects");
  }

  createProject(a: {
    name?: string;
    description?: string;
    workspace?: string;
    scratch?: boolean;
    model?: string;
    effort?: string;
    mode?: string;
    multitask?: boolean;
  }): Promise<{ project: ProjectOut }> {
    return this.req("POST", "/api/projects", a);
  }

  patchProject(id: string, a: {
    name?: string;
    description?: string;
    model?: string;
    effort?: string;
    mode?: string;
    multitask?: boolean;
  }): Promise<{ project: ProjectOut }> {
    return this.req("PATCH", `/api/projects/${encodeURIComponent(id)}`, a);
  }

  deleteProject(id: string): Promise<{ ok: boolean }> {
    return this.req("DELETE", `/api/projects/${encodeURIComponent(id)}`);
  }

  projectThreads(projectId: string): Promise<{ threads: ThreadOut[] }> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/threads`);
  }

  createThread(a: {
    projectId: string;
    title?: string;
    text?: string;
    model?: string;
    effort?: string;
    mode?: string;
    multitask?: boolean | null;
  }): Promise<{ thread: ThreadOut }> {
    return this.req("POST", "/api/threads", a);
  }

  patchThread(id: string, a: ThreadSettings & { title?: string; projectId?: string; pinned?: boolean; archived?: boolean }): Promise<{ thread: ThreadOut }> {
    return this.req("PATCH", `/api/threads/${encodeURIComponent(id)}`, a);
  }

  deleteThread(id: string): Promise<{ ok: boolean }> {
    return this.req("DELETE", `/api/threads/${encodeURIComponent(id)}`);
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.req("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  sendMessage(id: string, text: string): Promise<unknown> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/messages`, { text });
  }

  stop(id: string): Promise<{ ok: boolean; dropped: string[]; prompt?: string }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/stop`, {});
  }

  rewind(id: string, a: { seq: number; text: string; restoreFiles?: boolean }): Promise<{ ok: boolean }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/rewind`, a);
  }

  restore(id: string, checkpoint: string): Promise<{ ok: boolean }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/restore`, { checkpoint });
  }

  compact(id: string): Promise<{ ok: boolean; reason?: string; before?: number; after?: number }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/compact`, {});
  }

  answers(id: string, a: { callId?: string; answers?: unknown[]; skip?: boolean }): Promise<{ ok: boolean }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/answers`, a);
  }

  tasks(id: string): Promise<{ tasks: unknown[] }> {
    return this.req("GET", `/api/threads/${encodeURIComponent(id)}/tasks`);
  }

  cancelTasks(id: string): Promise<{ ok: boolean; cancelled: number }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/tasks/cancel`, {});
  }

  cancelTask(id: string, taskId: string): Promise<{ ok: boolean }> {
    return this.req("POST", `/api/threads/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/cancel`, {});
  }

  taskTranscript(id: string, taskId: string): Promise<{ transcript: string; text: string; truncated: boolean }> {
    return this.req("GET", `/api/threads/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/transcript`);
  }

  localUsage(days: number): Promise<{ requests: unknown[]; totals: unknown }> {
    return this.req("GET", `/api/usage/local?days=${encodeURIComponent(String(days))}`);
  }

  providerUsage(provider: "muse" | "zai" | "chatgpt"): Promise<unknown> {
    return this.req("GET", `/api/providers/${encodeURIComponent(provider)}/usage`);
  }

  devinStatus(): Promise<unknown> {
    return this.req("GET", "/api/providers/devin/status");
  }
}
