# Lookout Marketplace

The official catalog of listings for Lookout. This repo is an index: listings.json is what the Customize tab reads, and each entry points at that listing's source.

## Repo layout

| Path | What it is |
| --- | --- |
| listings.json | the feed, one file the client fetches |
| listings.schema.json, scripts/validate-listings.ts | the gate |
| assets/ | icons, immutable per tag |
| servers/lookout-mcp/ | first-party MCP server; install and tools in that README |

The Lookout MCP server is documented in servers/lookout-mcp/README.md.

## Catalog

One entry per listing. The id is kebab-case and unique, the version is semver, and the source is a git tag or an npm version. Install holds the per-host targets on that same entry. A connector is not listed again per host. Anything the schema allows but the feed must reject is enforced by the validator and listings.test.ts.

## Versions

One version source, servers/lookout-mcp/package.json. The listing version and the tag lookout-mcp-vX.Y.Z move together. CI rejects drift. The live feed is listings.json on the default branch. A tag is the immutable copy.

## Development

```bash
bun install
bun run validate
bun test
bun run typecheck
```

## Contributing

See CONTRIBUTING.md. A listing change is a PR to listings.json and has to pass the schema gate.

## Security

See SECURITY.md. Report vulnerabilities in private. Do not open a public issue.

## License

MIT. See LICENSE. Lookout and the Arcadia mark are Arcadia's.
