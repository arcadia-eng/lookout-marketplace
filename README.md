# lookout-marketplace

[![CI](https://github.com/tivris/lookout-marketplace/actions/workflows/ci.yml/badge.svg)](https://github.com/tivris/lookout-marketplace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official [Lookout](https://arcadiausercontent.com) marketplace: the
listing index the Lookout Customize tab reads, plus the first listing:
the Lookout MCP server (`servers/lookout-mcp/`), Lookout-as-server over
Streamable HTTP + OAuth 2.1.

## Try the connector

```bash
# needs a running Lookout app/server on the machine; see the full README:
LOOKOUT_MCP_TOKEN="$(openssl rand -hex 32)" bunx @arcadia/lookout-mcp
```

Full quickstart, the 22-tool surface and deploy runbook:
[servers/lookout-mcp/README.md](servers/lookout-mcp/README.md).

## Layout

- `listings.json`: the machine-readable feed (envelope `schemaVersion` 1).
  The client fetches one file and renders install actions; entries carry
  their own publisher and per-host install targets.
- `listings.schema.json`: the JSON Schema for the feed; CI rejects a bad
  listing (`bun run validate` also checks unique ids and the single
  version source).
- `assets/`: listing icons referenced by URL (immutable per tag).
- `servers/lookout-mcp/`: listing #1: the Lookout MCP bridge
  ([README](servers/lookout-mcp/README.md), MIT).
- `plugins/`: later: Lookout plugins move here (none yet).

## Trust

Official-vs-third-party is decided by *which feed you read*, never by a
badge field: this repository is the official feed, served from the
publisher's own GitHub over TLS, changed only through reviewed PRs. The
`publisher.verified` flag and a listing signature are reserved (schema v1)
for third-party feeds and activate without a schema break. No third-party
features, signatures, MCP resources/prompts or outbound OAuth exist in v1.

## Listing ontology (v1)

Each entry: `id` (kebab-case, unique), `kind` (`connector` | `plugin` |
`skill`), `name`, `version` (semver, the update signal), `description`,
`author`, `license`, `homepage`, `repository` (with `directory`),
`icon`/`iconDark` (https URLs), `lookout` (semver range the listing needs,
à la `engines.vscode`), `publisher` `{name, url}`, `source`
(`{type: "github", repo, path, ref}` (an immutable git tag) or
`{type: "npm", package, version}`), and `install[]` per-host targets
(`{host, transport: http|stdio, url?/command?, args?, env?, auth}`).

The MCP server is listed once as a general connector with per-host install
targets: never re-listed per host.

## Versions and tags

One version source: `servers/lookout-mcp/package.json` drives the listing's
`version` and the immutable `source.ref` tag `lookout-mcp-vX.Y.Z` (CI
enforces). Feed history is immutable per tag
(`https://cdn.jsdelivr.net/gh/tivris/lookout-marketplace@<tag>/listings.json`);
the live feed is `listings.json` on the default branch.

## Development

Bun only (no npm/node needed):

```bash
bun install
bun run validate     # listings.json vs schema + invariants
bun test             # server unit suites + feed test
bun run typecheck    # tsc --noEmit on the server
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): listings land by PR against
`listings.json` and must pass the schema gate.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately through
GitHub: never in a public issue.

## License

MIT: see [LICENSE](LICENSE). "Lookout" and the Arcadia mark are Arcadia's.
