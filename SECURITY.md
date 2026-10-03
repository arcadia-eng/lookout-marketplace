# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub: this repository's **Security** tab →
**Report a vulnerability**. You should get a first response within a few
days.

A good report includes the affected version or tag, a minimal
reproduction, and which layer it touches: the feed schema/validator or
the MCP server. Redact tokens, client secrets and grant ids; never paste
a live credential.

## Scope

- `servers/lookout-mcp/`: the OAuth 2.1 authorization server (dynamic
  registration, PKCE, consent delegation, refresh rotation), the
  loopback Lookout API client, and operator-token handling.
- `listings.json` / `listings.schema.json`: validation bypasses: a
  listing that installs something a reviewer would reject while passing
  the gate is a security bug.

## Supported versions

The latest `lookout-mcp-v*` tag. Older tags are immutable snapshots and
aren't patched: update to current.

## Self-hosting notes

The server binds `127.0.0.1` only; expose it through your own TLS
proxy/tunnel. `LOOKOUT_MCP_TOKEN` is the operator Bearer: it grants the
full tool surface, so keep it out of issues, logs and commits (generate
it into a mode-600 file as the README shows, and rotate by restarting).
