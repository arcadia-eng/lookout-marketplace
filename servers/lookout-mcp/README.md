# Lookout MCP server

Drive Lookout from any MCP host over Streamable HTTP. The server is a separate process in front of Lookout's loopback API. Sign-in for people is OAuth 2.1. Local use takes a raw operator Bearer.

## Quickstart (self-hosted, raw Bearer)

You need a running Lookout desktop app or `lookout` server on the machine
(the server talks to it over loopback).

```bash
git clone https://github.com/arcadia-eng/lookout-marketplace.git
cd lookout-marketplace/servers/lookout-mcp

# Operator token: generate once, keep in a private file: this value IS the
# Bearer your client sends below. Never commit it (.mcp-token is gitignored).
openssl rand -hex 32 > .mcp-token && chmod 600 .mcp-token

LOOKOUT_MCP_TOKEN="$(cat .mcp-token)" bun src/main.ts   # :8792
```

From the packed package (no checkout) the same entry is a bin: the
executable carries a Bun shebang, so it runs wherever Bun is installed:

```bash
LOOKOUT_MCP_TOKEN="$(cat .mcp-token)" bunx @arcadia/lookout-mcp   # = bunx lookout-mcp; same env vars
```

Point any MCP client at `http://127.0.0.1:8792/mcp`, authenticating with
the token you generated:

```
Authorization: Bearer <contents of .mcp-token>
```

or from the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
`bunx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL
`http://127.0.0.1:8792/mcp`, Bearer `$(cat .mcp-token)`. `initialize`
answers with the tool surface (22 tools).

For remote access, put the port behind an HTTPS reverse proxy or tunnel
(cloudflared, ngrok, Caddy, anything that terminates TLS and forwards to
`127.0.0.1:8792`) and set `LOOKOUT_MCP_PUBLIC_URL` to the public origin.
The server binds `127.0.0.1` only; the proxy forwards in.

### OAuth (account consent): additionally requires an origin

The raw Bearer above is the operator credential for local dev and tests.
Human sign-in uses OAuth 2.1 with the consent step delegated to a Lookout
accounts origin: besides `LOOKOUT_MCP_TOKEN`, OAuth needs

- `LOOKOUT_MCP_ORIGIN_URL`: the accounts origin (consent pages +
  server-to-server grant calls), and
- `LOOKOUT_MCP_BRIDGE_TOKEN`: the bridge credential that origin accepts.

Self-hosting consent means running that origin too; without both, the raw
Bearer still works and `/authorize` answers 503 (browser consent
unavailable). Codes, access/refresh tokens and pending consents are minted
in memory: **a restart ends every live session, but the client's
registration survives** (`LOOKOUT_MCP_CLIENTS_FILE` below), so reauth is
one authorize + consent hop, not a fresh dynamic registration.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LOOKOUT_MCP_TOKEN` | - (required) | raw Bearer for the local Inspector/tests; always the full tool surface |
| `LOOKOUT_URL` | `http://127.0.0.1:8789` | the Lookout server to drive (loopback) |
| `LOOKOUT_MCP_PORT` | `8792` | listen port (host `127.0.0.1`) |
| `LOOKOUT_MCP_PUBLIC_URL` | `http://127.0.0.1:<port>` | the origin hosts reach (drives OAuth redirects + icon URLs) |
| `LOOKOUT_MCP_ROOTS` | - (empty) | comma-separated canonical roots `lookout_delegate`/`lookout_create_project` may create workspaces under; empty = existing projects only |
| `LOOKOUT_MCP_ORIGIN_URL` | `https://arcadiausercontent.com` | accounts origin for consent + grant checks |
| `LOOKOUT_MCP_BRIDGE_TOKEN` | - | bridge→origin credential; unset disables browser consent (503), raw Bearer unaffected |
| `LOOKOUT_MCP_BRIDGE_LABEL` | hostname | shown on the consent screen and in Sessions |
| `LOOKOUT_MCP_CLIENTS_FILE` | `$XDG_CONFIG_HOME/lookout/mcp/clients.json` (`~/.config/…` without XDG) | durable dynamic-client registry: 0600 file, atomic writes, strictly revalidated on load; delete to reset all registrations |

## Transport & auth

- Streamable HTTP at `/mcp` via the official MCP TS SDK. Stateless: each
  request gets a fresh transport, no session affinity: plain JSON
  request/response. Our tools are request/response by design (delegate
  returns a thread id immediately, progress is polled with `check`), so
  there is no SSE streaming and no server-initiated progress.
- OAuth 2.1 authorization server (RFC 8414 discovery, dynamic registration,
  S256 PKCE code flow, rotating refresh). Every refresh revalidates the
  grant against the origin: revoking the connection refuses the next
  refresh, so a revoked connector dies with its live access token: at
  most 5 minutes (`ACCESS_TOKEN_TTL_SEC`) after revoke. Refresh lifetime
  is 30 days (`REFRESH_TTL_MS`). A refresh during an origin outage is 503
  without consuming the token.
- Per-connection tool scopes: a consented grant can carry a subset of the
  22 tools. `tools/list` filters to the scope; `tools/call` outside it is
  refused before the Lookout server is ever reached, with an error naming
  the scope. The raw operator Bearer always sees the full surface.

## Tool surface

| MCP tool | What it does |
|---|---|
| `lookout_status` | server load, models, plan usage per provider, projects, running chats: call before delegating |
| `lookout_models` | curated model rows with effort ladders |
| `lookout_usage` / `lookout_usage_local` | provider plan windows / this machine's turns |
| `lookout_delegate` | one call: project + chat + prompt; returns the thread id immediately (omit prompt for an empty chat) |
| `lookout_check` | poll a chat: `statusLine` (working/needs-you/done), bounded entry tail with cursors, todos, pending question, background tasks |
| `lookout_list` / `lookout_projects` | recent chats / project rows |
| `lookout_steer` / `lookout_stop` | follow-up message / stop the turn + background runs |
| `lookout_rewind` / `lookout_restore` | edit & resend from a seq / reset files to a checkpoint |
| `lookout_compact` | compact a chat's context now |
| `lookout_answer` | answer the chat's pending question so a waiting turn continues |
| `lookout_configure` / `lookout_configure_project` | retune a chat / a project's defaults |
| `lookout_create_project` / `lookout_delete_project` / `lookout_delete_thread` | empty project shells / deletions |
| `lookout_tasks` / `lookout_cancel_task` / `lookout_task_transcript` | background Task runs |

Follow-ups reuse the same thread id (never a fresh delegate). Coding
outlasts an MCP call: poll `lookout_check` ~30s, read `statusLine` first.

## Safety

- `LOOKOUT_MCP_TOKEN` is the raw Bearer for the local Inspector and tests:
  no human flow asks for it. The server binds 127.0.0.1; a public URL
  must come from your own TLS proxy. Rotate by restarting.
- OAuth registration is open, but redirects must be https (http loopback
  only); codes are single-use PKCE; refresh tokens rotate. Registrations
  persist at `LOOKOUT_MCP_CLIENTS_FILE`: strictly revalidated on load;
  a file that fails validation is preserved byte-for-byte and DCR answers
  503 until it is repaired or removed, never overwritten blind.
- `LOOKOUT_MCP_ROOTS` gates workspace creation: delegate may create
  workspaces only under these canonicalized roots; unset means existing
  projects only.
- No credential handling: the server never touches provider token stores;
  it only drives the local API as the operator.
- A message starting with `#` is Lookout's memory shortcut; the bridge
  escapes it so it runs as a turn, and says so in the result.

## Deploy

See [docs/deploy.md](docs/deploy.md) for the runbook shape: process
supervisor (launchd/systemd), token file handling, TLS proxy fronting and
rollback. No secrets are included.

## Development

```bash
bun install
bun test          # oauth + tools + branding suites
bun run typecheck
```

`src/` layout: `main.ts` executable entry, `index.ts` side-effect-free
package surface, `app.ts` Hono wiring, `client.ts` loopback API client,
`tools.ts` the 22 tools, `oauth.ts` the OAuth 2.1 AS, `branding.ts` +
`icon-180.png`/`favicon.ico` the connector identity, `paths.ts` the
vendored canonical-path utility.

## License

MIT. See LICENSE.
