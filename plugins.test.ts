// The Claude Code marketplace as a test: every entry in
// .claude-plugin/marketplace.json resolves to a plugin directory whose
// manifest carries the same name and version.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const market = read(".claude-plugin/marketplace.json") as {
  name: string;
  plugins: { name: string; source: string; version: string }[];
};

describe("claude code marketplace", () => {
  test("every entry resolves to a plugin with the same name and version", () => {
    expect(market.plugins.length).toBeGreaterThan(0);
    for (const entry of market.plugins) {
      expect(entry.source).toBe(`./plugins/${entry.name}`);
      const manifest = join(entry.source, ".claude-plugin", "plugin.json");
      expect(existsSync(join(root, manifest))).toBe(true);
      const plugin = read(manifest) as { name: string; version: string };
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(entry.version);
    }
  });

  test("the lookout plugin starts its MCP server through the Bun launcher", () => {
    const mcp = read("plugins/lookout/.mcp.json") as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers.lookout?.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh");
    expect(existsSync(join(root, "plugins/lookout/scripts/bun.sh"))).toBe(true);
  });
});
