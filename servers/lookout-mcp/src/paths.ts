// Vendored from the Lookout monorepo's src/paths.ts (canonicalPath only:
// the one path utility the bridge needs). Kept behavior-identical: the
// Lookout-side contract suite (src/mcp-contract in the monorepo) pins this
// copy against the original through the packed package.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Where an absolute path really is: symlinks in its existing part resolved
 * (macOS /tmp is /private/tmp), any not-yet-created rest appended as given.
 */
export function canonicalPath(absPath: string): string {
  const rest: string[] = [];
  for (let cur = resolve(absPath); ;) {
    try { return join(realpathSync(cur), ...rest); } catch { /* not there yet: try the parent */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(absPath);
    rest.unshift(basename(cur));
    cur = parent;
  }
}
