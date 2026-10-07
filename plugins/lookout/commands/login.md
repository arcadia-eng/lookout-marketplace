---
description: Sign this plugin in to your Lookout account, on a machine without the Lookout app
---

Sign the Lookout plugin in to Lookout's hosted MCP. A machine with the Lookout app needs no sign-in: the plugin uses the app.

Run this with a 10 minute timeout. It opens the browser at Lookout's sign-in page and waits until the person signs in there:

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/login.ts"
```

If the browser does not open, give the person the address the script printed. Once it says `signed in`, the `lookout` tools work on their next call. If `/mcp` shows the `lookout` server as failed, reconnect it there.

The script never prints a token. Do not read or print the file it names.
