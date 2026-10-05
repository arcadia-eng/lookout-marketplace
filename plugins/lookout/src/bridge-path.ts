// Where the stdio bridge (`src/mcp/stdio.ts`) is on this machine. A checkout
// (LOOKOUT_ROOT, the plugin's own tree, the session's folder) wins; otherwise
// the installed Lookout's own pinned copy: the Mac app's snapshot, or the
// headless install under ~/.lookout/cli. A plugin installed from the
// marketplace lives in Claude Code's cache with no src/mcp of its own, so the
// installed app is what lets it start the bridge even while Lookout is down.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ENTRY = join("src", "mcp", "stdio.ts");

/** Walk up from each start (at most `limit` parents) for the bridge entry. */
export function findStdioEntry(starts: readonly string[], limit = 8): string | null {
  const seen = new Set<string>();
  for (const start of starts) {
    if (!start.trim()) continue;
    let dir = resolve(start);
    for (let i = 0; i < limit; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const candidate = join(dir, ENTRY);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** A bridge to run: its entry, and the bun that runs it (the install's own when it ships one). */
export interface Bridge { entry: string; bun: string }

/** The installed Lookouts' pinned trees, each with the bun it ships. */
export function installedRoots(home = homedir()): { root: string; bun: string }[] {
  const app = (base: string) => {
    const root = join(base, "Lookout.app", "Contents", "Resources", "app.asar.unpacked", "snapshot");
    return { root, bun: join(root, "bin", "bun") };
  };
  return [
    app("/Applications"),
    app(join(home, "Applications")),
    { root: join(home, ".lookout", "cli", "current"), bun: join(home, ".lookout", "cli", "bun", "bin", "bun") },
  ];
}

/** The bridge for this session: a checkout first, then an installed Lookout; null when neither has one. */
export function findBridge(starts: readonly string[], installed = installedRoots()): Bridge | null {
  const fromCheckout = findStdioEntry(starts);
  if (fromCheckout) return { entry: fromCheckout, bun: "bun" };
  for (const i of installed) {
    const entry = join(i.root, ENTRY);
    if (existsSync(entry)) return { entry, bun: existsSync(i.bun) ? i.bun : "bun" };
  }
  return null;
}
