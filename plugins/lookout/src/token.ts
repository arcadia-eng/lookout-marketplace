import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default file the HTTP bridge's operator token lives in. Never printed. */
export function defaultTokenFile(env: Record<string, string | undefined>, home = homedir()): string {
  if (env.LOOKOUT_MCP_TOKEN_FILE?.trim()) return env.LOOKOUT_MCP_TOKEN_FILE.trim();
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "lookout", "mcp-token");
}

export interface Bearer {
  token: string | null;
  /** Safe to print: never the token, never the file body. */
  error: string | null;
}

/**
 * The bearer for an already-running local bridge. `LOOKOUT_MCP_TOKEN` wins.
 * A missing file is "no token", not an error. A read failure names the path
 * and the code, not the contents.
 */
export function readBearer(
  env: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  home?: string,
): Bearer {
  const fromEnv = env.LOOKOUT_MCP_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, error: null };
  const path = defaultTokenFile(env, home);
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (code === "ENOENT") return { token: null, error: null };
    return { token: null, error: `could not read the bridge token file (${code || "error"})` };
  }
  const token = text.trim();
  if (!token) return { token: null, error: null };
  return { token, error: null };
}
