import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's data folder for this plugin: `<plugin>-<marketplace>` under its config dir's plugins/data. */
export const PLUGIN_DATA_NAME = "lookout-lookout-marketplace";

/**
 * Where the plugin keeps what outlives one process (the follow watcher's cursor and marks, the channel's
 * subscription): CLAUDE_PLUGIN_DATA when Claude Code set it (MCP servers, hooks), else the folder it would be, else
 * a config folder of its own. A Bash or Monitor command does not carry CLAUDE_PLUGIN_DATA.
 */
export function pluginDataDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const set = env.CLAUDE_PLUGIN_DATA?.trim();
  if (set) return set;
  const claude = join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "plugins", "data", PLUGIN_DATA_NAME);
  if (existsSync(claude)) return claude;
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "lookout", "claude-plugin");
}
