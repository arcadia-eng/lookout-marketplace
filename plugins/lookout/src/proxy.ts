// One JSON-RPC message from Claude's stdio to the bridge's Streamable HTTP
// endpoint, and the response (if the message was a request) back. The HTTP
// bridge answers JSON (`enableJsonResponse`); an SSE body is accepted too.

export interface ForwardInput {
  mcpUrl: string;
  token: string | null;
  sessionId: string | null;
  fetchFn?: typeof fetch;
}

export interface ForwardResult {
  /** Null when the server had nothing to say (a notification, an empty 202). */
  response: unknown | null;
  sessionId: string | null;
  status: number;
}

export function rpcError(id: unknown, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } };
}

/** Pull the JSON-RPC object out of a JSON body or an SSE `data:` line. */
export function parseMcpBody(contentType: string, text: string): unknown | null {
  const body = text.trim();
  if (!body) return null;
  if (contentType.includes("text/event-stream")) {
    const data = body.split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(5).trim())
      .filter(l => l.length > 0 && l !== "[DONE]");
    const last = data.at(-1);
    if (!last) return null;
    return JSON.parse(last) as unknown;
  }
  return JSON.parse(body) as unknown;
}

export function signInMessage(remote: boolean): string {
  return remote
    ? "Lookout remote MCP refused the call. Run scripts/login.ts in this plugin (bun scripts/login.ts) and retry. No token was printed."
    : "The local Lookout bridge refused the bearer. Set LOOKOUT_MCP_TOKEN, or check the token file. The token was not printed.";
}

/** A forward that reached nothing: where it tried, and that the next call tries again. */
export function unreachableMessage(mcpUrl: string, e: unknown): string {
  const why = e instanceof Error ? e.message : String(e);
  return `Lookout's MCP at ${mcpUrl} is not answering (${why}): Lookout is starting or not running. This connection stays up; call again once it is.`;
}

export async function forwardRpc(message: unknown, input: ForwardInput): Promise<ForwardResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.sessionId) headers["mcp-session-id"] = input.sessionId;
  let res: Response;
  try {
    res = await fetchFn(input.mcpUrl, { method: "POST", headers, body: JSON.stringify(message) });
  } catch (e) {
    // status 0: nothing answered. The caller reports it per call and stays up.
    const id = message && typeof message === "object" && "id" in message ? (message as { id: unknown }).id : null;
    return { response: rpcError(id, unreachableMessage(input.mcpUrl, e)), sessionId: input.sessionId, status: 0 };
  }
  const sessionId = res.headers.get("mcp-session-id") ?? input.sessionId;
  const text = await res.text();
  if (res.status === 401) {
    const id = message && typeof message === "object" && "id" in message ? (message as { id: unknown }).id : null;
    return { response: rpcError(id, signInMessage(input.mcpUrl.startsWith("https://"))), sessionId, status: 401 };
  }
  if (!text.trim()) return { response: null, sessionId, status: res.status };
  try {
    return { response: parseMcpBody(res.headers.get("content-type") ?? "", text), sessionId, status: res.status };
  } catch {
    const id = message && typeof message === "object" && "id" in message ? (message as { id: unknown }).id : null;
    return { response: rpcError(id, `Lookout MCP returned a body that was not JSON (HTTP ${res.status}).`), sessionId, status: res.status };
  }
}
