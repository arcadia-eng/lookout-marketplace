// Loopback reads of the Lookout app. The header is the same contract the
// MCP bridge sends (`x-lookout-client: mcp` in src/mcp/client.ts).

export const CLIENT_HEADER = "x-lookout-client";

export async function localGet(base: string, path: string, ms: number, fetchFn: typeof fetch = fetch): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`, {
      headers: { [CLIENT_HEADER]: "mcp", accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeApp(base: string, ms = 400, fetchFn?: typeof fetch): Promise<boolean> {
  const body = await localGet(base, "/api/health", ms, fetchFn);
  return !!body && typeof body === "object";
}

export async function probeBridge(origin: string, ms = 400, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const body = await localGet(origin, "/health", ms, fetchFn);
  return !!body && typeof body === "object" && (body as { service?: string }).service === "lookout-mcp";
}
