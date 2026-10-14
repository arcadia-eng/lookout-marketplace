// The feed gate as a test: listings.json validates against the schema,
// ids are unique, the lookout-mcp listing tracks the package version, a
// connector tracks its folder, and the schema/validator reject the shapes a
// pattern alone would miss: transport without its required field, bare
// `https://`, non-https icons, unknown enums, a lookout target that could
// run a command or choose its own client.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateListings } from "./scripts/validate-listings";

const root = dirname(fileURLToPath(import.meta.url));
const feed = JSON.parse(readFileSync(join(root, "listings.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "servers/lookout-mcp/package.json"), "utf8")) as { version: string };

/** The real feed with one mutation applied to one listing (lookout-mcp unless named). */
function mutated(mutate: (listing: Record<string, unknown>) => void, id = "lookout-mcp"): unknown {
  const clone = structuredClone(feed) as { listings: Record<string, unknown>[] };
  mutate(clone.listings.find(l => l.id === id)!);
  return clone;
}

describe("listings feed", () => {
  test("validates against the schema with unique ids and one version source", () => {
    expect(validateListings(feed, pkg.version)).toEqual([]);
  });

  test("the lookout-mcp listing is a general connector with per-host install targets", () => {
    const mcp = (feed as { listings: { id: string; kind: string; install: { host: string; transport: string; url: string }[] }[] })
      .listings.find(l => l.id === "lookout-mcp")!;
    expect(mcp.kind).toBe("connector");
    expect(mcp.install.length).toBeGreaterThanOrEqual(2);
    for (const t of mcp.install) expect(t.transport).toBe("http");
    expect(new Set(mcp.install.map(t => t.url)).size).toBe(1);
  });
});

describe("feed gate rejects malformed listings", () => {
  test("an http install target without a url fails", () => {
    const bad = mutated(mcp => {
      const install = mcp.install as Record<string, unknown>[];
      delete install[0]!.url;
    });
    expect(validateListings(bad, pkg.version).join("\n")).toMatch(/install\/0.*url/);
  });

  test("a stdio install target without a command fails", () => {
    const bad = mutated(mcp => {
      const install = mcp.install as Record<string, unknown>[];
      install[0] = { host: "generic", label: "x", transport: "stdio", auth: {} };
    });
    expect(validateListings(bad, pkg.version).join("\n")).toMatch(/install\/0.*command/);
  });

  test("a bare https:// homepage fails (host required)", () => {
    const bad = mutated(mcp => { mcp.homepage = "https://"; });
    expect(validateListings(bad, pkg.version).join("\n")).toMatch(/homepage/);
  });

  test("a non-parseable homepage and a plain-http homepage both fail", () => {
    for (const homepage of ["https://exa mple.com/oops", "http://github.com/x/y"]) {
      const bad = mutated(mcp => { mcp.homepage = homepage; });
      expect(validateListings(bad, pkg.version).join("\n")).toMatch(/homepage/);
    }
  });

  test("a non-https icon fails (ftp)", () => {
    const bad = mutated(mcp => { mcp.icon = "ftp://example.com/icon.svg"; });
    expect(validateListings(bad, pkg.version).join("\n")).toMatch(/icon/);
  });

  test("unknown transport and kind enums fail", () => {
    const grpc = mutated(mcp => {
      (mcp.install as Record<string, unknown>[])[0]!.transport = "grpc";
    });
    expect(validateListings(grpc, pkg.version).join("\n")).toMatch(/transport/);
    const theme = mutated(mcp => { mcp.kind = "theme"; });
    expect(validateListings(theme, pkg.version).join("\n")).toMatch(/kind/);
  });

  test("duplicate ids and version drift fail", () => {
    const dup = structuredClone(feed) as { listings: unknown[] };
    dup.listings.push(structuredClone(dup.listings[0]));
    expect(validateListings(dup, pkg.version).join("\n")).toMatch(/duplicate listing id/);
    expect(validateListings(feed, "9.9.9").join("\n")).toMatch(/version drift/);
  });
});

describe("connectors Lookout dials", () => {
  type Target = Record<string, unknown>;
  const target = (l: Record<string, unknown>) => (l.install as Target[])[0]!;

  test("a lookout target that runs a command, skips https or names no sign-in policy fails", () => {
    const shapes: ((t: Target) => void)[] = [
      t => { t.transport = "stdio"; t.command = "sh"; delete t.url; },
      t => { t.url = "http://gmailmcp.googleapis.com/mcp/v1"; },
      t => { t.auth = { type: "oauth", clientId: "x" }; },
      t => { t.auth = { type: "oauth2-pkce", scope: "mcp" }; },
    ];
    for (const shape of shapes)
      expect(validateListings(mutated(l => shape(target(l)), "gmail"), pkg.version).length).toBeGreaterThan(0);
  });

  test("an audience that isn't sha256 hex, and unknown availability, fail", () => {
    expect(validateListings(mutated(l => { l.audience = ["usr_owner"]; }, "gmail"), pkg.version).join("\n")).toMatch(/audience/);
    expect(validateListings(mutated(l => { l.availability = "beta"; }, "gmail"), pkg.version).join("\n")).toMatch(/availability/);
  });

  test("the entry and its folder move together", () => {
    expect(validateListings(mutated(l => { l.version = "1.0.1"; }, "gmail"), pkg.version).join("\n")).toMatch(/plugin\.json|source\.ref/);
    expect(validateListings(mutated(l => { target(l).url = "https://example.com/mcp"; }, "gmail"), pkg.version).join("\n")).toMatch(/mcp\.json/);
  });
});
