# Lookout Marketplace

Lookout is a coding agent harness that runs on your own model subscriptions. This repo is its official marketplace: the Lookout plugin for Claude Code, the listings feed the Lookout app reads, and the Lookout MCP server.

## Claude Code plugin

The `lookout` plugin drives a Lookout account from Claude Code. It hands tasks to Lookout chats on any model or machine the account has, steers and waits on them, reads provider quotas, and reviews what a chat changed. Its tools come from the MCP bridge bundled with the installed Lookout app or CLI.

### Requirements

- Claude Code
- Lookout desktop app or CLI, installed and signed in

### Install

```text
/plugin marketplace add arcadia-eng/lookout-marketplace
/plugin install lookout@lookout-marketplace
/reload-plugins
```

From a shell:

```bash
claude plugin marketplace add arcadia-eng/lookout-marketplace
claude plugin install lookout@lookout-marketplace
```

### What it adds

| Component | Name | Purpose |
|---|---|---|
| MCP server | `lookout` | Lookout's tools: `lookout_delegate`, `lookout_check`, `lookout_fleet`, `lookout_steer`, `lookout_changes`, `lookout_machines`, `lookout_usage` and more |
| Agent | `lookout:worker` | Hands one task to a Lookout chat, waits, and returns the reply |
| Command | `/lookout:delegate` | Hand a task to Lookout, with optional `--model`, `--effort` and `--machine` |
| Command | `/lookout:steer` | Send a follow-up into a chat |
| Command | `/lookout:status` | Running chats, machines and provider quotas |
| Command | `/lookout:machines` | List machines and select one |
| Skill | `orchestrate` | Run a fleet of chats across lanes and machines |
| Skill | `review` | Review the diff of a Lookout chat |
| Skill | `models` | Pick a model by remaining plan quota |
| Skill | `machines` | See and choose Lookout machines |
| Skill | `vps-workers` | Enroll a Linux VPS and run chats on it |
| Hook | `SessionStart` | Tells a new session which Lookout chats are running |
| Status line | subagent | Count of running Lookout chats |

The plugin connects whether or not Lookout is running; calls succeed once the app is up. It uses the Bun that Lookout ships when Bun is not installed.

## Listings feed

`listings.json` is the catalog the Lookout app's Customize tab reads. Each entry points at a listing's source. `listings.schema.json` and `scripts/validate-listings.ts` gate it.

## Lookout MCP server

`servers/lookout-mcp/` serves Lookout's tools over Streamable HTTP with OAuth 2.1, for MCP hosts such as Grok. Install and tools are in its README.

## Repo layout

| Path | Contents |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace index |
| `plugins/lookout/` | Lookout plugin for Claude Code |
| `listings.json` | Lookout listings feed |
| `listings.schema.json`, `scripts/` | Feed schema and validator |
| `servers/lookout-mcp/` | Lookout MCP server |
| `assets/` | Icons, pinned per tag |

## Versions

The plugin's version lives in `plugins/lookout/.claude-plugin/plugin.json` and its marketplace entry, and is tagged `vX.Y.Z`. The server's version lives in `servers/lookout-mcp/package.json` and is tagged `lookout-mcp-vX.Y.Z`. CI rejects drift.

## Development

```bash
bun install
bun run validate
bun test
bun run typecheck
claude plugin validate --strict .
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately, not in a public issue.

## License

MIT. See [LICENSE](LICENSE). Lookout and the Arcadia mark are Arcadia's.
