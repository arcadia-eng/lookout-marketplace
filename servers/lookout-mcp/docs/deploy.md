# Deploying the Lookout MCP server

The runbook shape for running the bridge as a service. It assumes a
machine with the Lookout app/server running locally; nothing here carries
a secret: fill in your own values.

## Process

Run `bun src/main.ts` under a supervisor that starts at boot and restarts
unconditionally on exit. Prefer a small wrapper so the token never rides
`ps` output: mode 600, owned by the service user:

```sh
#!/bin/sh
# /opt/lookout-mcp/run.sh  (chmod 700, owner-only)
set -a
. /opt/lookout-mcp/env        # chmod 600: LOOKOUT_MCP_TOKEN=…, LOOKOUT_MCP_ROOTS=…
set +a
exec /usr/local/bin/bun /opt/lookout-mcp/src/main.ts
```

macOS launchd sketch:

```xml
<!-- ~/Library/LaunchAgents/com.example.lookout-mcp.plist -->
<dict>
  <key>Label</key><string>com.example.lookout-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/lookout-mcp/run.sh</string>
  </array>
  <key>StandardOutPath</key><string>/var/log/lookout-mcp.log</string>
  <key>StandardErrorPath</key><string>/var/log/lookout-mcp.log</string>
</dict>
```

On Linux, the same wrapper under systemd with `Restart=always`.

Dynamic client registrations persist across restarts (the
`LOOKOUT_MCP_CLIENTS_FILE` registry); tokens, codes and pending consents
are memory-only, so a restart ends live sessions: clients re-consent on
their saved registration. Treat restarts as routine.

## Network

The server binds `127.0.0.1:8792`. Hosts on the internet need an HTTPS
front:

- **Reverse SSH tunnel** to a small VPS running Caddy/nginx with automatic
  TLS, proxying to the forwarded port. An SSM-proxied session
  (`ProxyCommand aws ssm start-session …`) reaches hosts with no inbound
  firewall rule at all: nothing depends on the operator's public IP.
- **cloudflared / ngrok**: `cloudflared tunnel --url http://127.0.0.1:8792`
  (Streamable HTTP works over quick tunnels).

Set `LOOKOUT_MCP_PUBLIC_URL` to the public origin: OAuth redirects, the
protected-resource metadata and the icon URLs derive from it. Long-lived
connections should avoid proxies with aggressive idle timeouts; plain JSON
request/response keeps this mostly moot.

## Rollback

Deploy a new checkout alongside, flip the supervisor's program path,
restart, then remove the old path. Verify with `GET /health` and one
`initialize` + `lookout_status` round trip from a real MCP client (the
Inspector with the raw token is enough). Rollback is flipping the path
back: a restart re-consents clients on their persisted registration
anyway.
