// Where a Claude Code session should attach. An explicit LOOKOUT_URL (a
// hermetic server, a non-default port) always wins, so a test never falls
// through to the app on 8789. Otherwise the stdio bridge whenever this
// machine has one (a checkout or the installed app), whether or not Lookout is
// running yet: it answers tools/list at once, says "not running" per call,
// and reaches the app the moment it is up, so Claude Code never records a
// failed server. Without a bridge on disk: a bridge already listening, then
// the hosted MCP.

export const LOCAL_APP_URL = "http://127.0.0.1:8789";
export const LOCAL_BRIDGE_ORIGIN = "http://127.0.0.1:8792";
export const LOCAL_BRIDGE_MCP = `${LOCAL_BRIDGE_ORIGIN}/mcp`;
export const REMOTE_MCP_URL = "https://mcp.arcadiausercontent.com/mcp";

export interface Probe {
  /** GET /api/health on the local app answered. */
  appUp: boolean;
  /** The HTTP bridge's /health named lookout-mcp. */
  bridgeUp: boolean;
}

export type Target =
  | { mode: "stdio"; lookoutUrl: string }
  | { mode: "http"; mcpUrl: string; lookoutUrl: string }
  | { mode: "remote"; mcpUrl: string };

export type Resolved =
  | Target
  | { mode: "missing"; lookoutUrl: string; reason: string };

function clean(value: string | undefined): string {
  const v = value?.trim().replace(/\/$/, "") ?? "";
  return v;
}

/**
 * The first choice. `stdioOnDisk`: this machine has the bridge (a checkout or
 * the installed app); then it is the target, the app up or not, and no probe
 * is needed (`probe` may be null).
 */
export function chooseTarget(env: Record<string, string | undefined>, probe: Probe | null, opts: { stdioOnDisk?: boolean } = {}): Target {
  const explicit = clean(env.LOOKOUT_URL);
  if (explicit) return { mode: "stdio", lookoutUrl: explicit };
  if (env.LOOKOUT_MCP_REMOTE === "1") {
    return { mode: "remote", mcpUrl: clean(env.LOOKOUT_MCP_REMOTE_URL) || REMOTE_MCP_URL };
  }
  if (opts.stdioOnDisk || !probe) return { mode: "stdio", lookoutUrl: LOCAL_APP_URL };
  if (probe.appUp) return { mode: "stdio", lookoutUrl: LOCAL_APP_URL };
  if (probe.bridgeUp) return { mode: "http", mcpUrl: LOCAL_BRIDGE_MCP, lookoutUrl: LOCAL_APP_URL };
  return { mode: "remote", mcpUrl: clean(env.LOOKOUT_MCP_REMOTE_URL) || REMOTE_MCP_URL };
}

/**
 * Stdio mode needs the bridge source (`src/mcp/stdio.ts`). When this plugin
 * is installed without the Lookout checkout, an already-running HTTP bridge
 * is the same server. Neither means the local app is up and we cannot talk
 * to it: say so, instead of silently using the remote account.
 */
export function resolveTarget(target: Target, opts: { stdioEntry: string | null; bridgeUp: boolean }): Resolved {
  if (target.mode !== "stdio") return target;
  if (opts.stdioEntry) return target;
  if (opts.bridgeUp) return { mode: "http", mcpUrl: LOCAL_BRIDGE_MCP, lookoutUrl: target.lookoutUrl };
  return {
    mode: "missing",
    lookoutUrl: target.lookoutUrl,
    reason: `Lookout is at ${target.lookoutUrl}, but this plugin cannot find src/mcp/stdio.ts and nothing is listening on ${LOCAL_BRIDGE_ORIGIN}. Set LOOKOUT_ROOT to a Lookout checkout, or start the bridge.`,
  };
}
