// listings.json gate: JSON Schema validation plus the invariants a schema
// cannot express: unique ids, one version source (listing version ===
// servers/lookout-mcp package version === the source ref tag; a connector's
// listing version === its plugin.json === the ref tag, its mcp.json naming
// the url Lookout dials), and the URL semantics mirrored from the Lookout
// monorepo's runtime validator (src/customize/listings.ts validateListing):
// icon/homepage must be parseable https URLs, install urls parseable
// http(s), and each transport carries its required field. A bad listing can
// never merge.
// CLI: bun run validate; test: listings.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export interface Feed {
  schemaVersion: number;
  listings: {
    id: string;
    version: string;
    homepage: string;
    icon: string;
    iconDark?: string;
    source: { type: string; ref?: string; path?: string };
    install: { host: string; transport: string; url?: string; command?: string }[];
  }[];
}

/** `new URL` semantics (not just a pattern): must parse, must be https. */
function httpsUrl(v: string): string | null {
  try {
    return new URL(v).protocol === "https:" ? null : "must be an https URL";
  } catch {
    return "must be an https URL";
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

/** A listing under connectors/: its folder's plugin.json and mcp.json agree with it. */
function connectorProblems(l: Feed["listings"][number]): string[] {
  const where = `listing ${l.id}`;
  const dir = l.source.path!;
  if (dir !== `connectors/${l.id}`) return [`${where}: source.path must be connectors/${l.id}`];
  if (!existsSync(join(root, dir, "plugin.json")) || !existsSync(join(root, dir, "mcp.json")))
    return [`${where}: ${dir} needs plugin.json and mcp.json`];
  const errors: string[] = [];
  const plugin = readJson(`${dir}/plugin.json`) as { name?: string; version?: string; license?: string };
  if (plugin.name !== l.id) errors.push(`${where}: plugin.json name ${plugin.name} != ${l.id}`);
  if (plugin.version !== l.version) errors.push(`version drift: listing ${l.id} ${l.version} != plugin.json ${plugin.version}`);
  if (plugin.license !== "MIT") errors.push(`${where}: plugin.json license must be MIT`);
  if (l.source.ref !== `${l.id}-v${l.version}`) errors.push(`${where}: source.ref ${l.source.ref} != ${l.id}-v${l.version}`);
  if (!l.icon.includes(`@${l.id}-v${l.version}/`)) errors.push(`${where}: icon must be pinned to ${l.id}-v${l.version}`);
  const servers = Object.values((readJson(`${dir}/mcp.json`) as { mcpServers?: Record<string, { url?: string }> }).mcpServers ?? {});
  const dialed = l.install.filter(t => t.host === "lookout").map(t => t.url);
  if (servers.length !== 1 || dialed.length !== 1 || servers[0]!.url !== dialed[0])
    errors.push(`${where}: mcp.json must name the one url its lookout install target dials`);
  return errors;
}

/** All problems found, empty when the feed is sound. */
export function validateListings(feed: unknown, pkgVersion: string): string[] {
  const errors: string[] = [];
  const schema = JSON.parse(readFileSync(join(root, "listings.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(feed)) {
    for (const e of validate.errors ?? []) errors.push(`schema: ${e.instancePath || "(root)"}: ${e.message}`);
    return errors;
  }
  const typed = feed as Feed;
  const ids = new Set<string>();
  for (const l of typed.listings) {
    const where = `listing ${l.id}`;
    if (ids.has(l.id)) errors.push(`duplicate listing id: ${l.id}`);
    ids.add(l.id);
    for (const [k, v] of [["homepage", l.homepage], ["icon", l.icon], ["iconDark", l.iconDark]] as const) {
      if (v !== undefined) {
        const problem = httpsUrl(v);
        if (problem) errors.push(`${where}: ${k} ${problem} (got "${v}")`);
      }
    }
    for (const [i, t] of l.install.entries()) {
      if (t.transport === "http") {
        if (t.url === undefined) errors.push(`${where}: install[${i}] (http) needs a url`);
        else {
          try {
            const u = new URL(t.url);
            if (u.protocol !== "https:" && u.protocol !== "http:") errors.push(`${where}: install[${i}].url must be http(s)`);
            if (t.host === "lookout" && u.protocol !== "https:") errors.push(`${where}: install[${i}].url for the lookout host must be https`);
          } catch {
            errors.push(`${where}: install[${i}].url must be a parseable http(s) URL (got "${t.url}")`);
          }
        }
      } else if (t.transport === "stdio" && t.command === undefined) {
        errors.push(`${where}: install[${i}] (stdio) needs a command`);
      }
    }
    if (l.source.type === "github" && l.source.path?.startsWith("connectors/")) errors.push(...connectorProblems(l));
  }
  const mcp = typed.listings.find(l => l.id === "lookout-mcp");
  if (!mcp) {
    errors.push("the lookout-mcp listing is missing");
    return errors;
  }
  // One version source: the server's package version drives the listing
  // version and the immutable source ref tag (lookout-mcp-vX.Y.Z).
  if (mcp.version !== pkgVersion) errors.push(`version drift: listing ${mcp.version} != package ${pkgVersion}`);
  if (mcp.source.type === "github" && mcp.source.ref !== `lookout-mcp-v${pkgVersion}`)
    errors.push(`source.ref ${mcp.source.ref} != lookout-mcp-v${pkgVersion}`);
  return errors;
}

if (import.meta.main) {
  const feed = JSON.parse(readFileSync(join(root, "listings.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "servers/lookout-mcp/package.json"), "utf8")) as { version: string };
  const errors = validateListings(feed, pkg.version);
  if (errors.length) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  console.log(`listings.json ok: ${(feed as Feed).listings.length} listing(s), lookout-mcp ${pkg.version}`);
}
