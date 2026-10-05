---
description: Fleet, machines, and provider quotas for this Lookout account
---

Show Lookout's fleet, machines, and quotas.

Run this and return its stdout as the report. Do not paraphrase it.

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/status.ts"
```

If the report says the local app is not answering, call the `lookout` MCP tools instead, once each, and report those:

- `lookout_status`
- `lookout_machines`
- `lookout_usage`
- `lookout_fleet` with `states: ["running", "needs_input", "failed", "quota", "background"]`

Do not poll. One call each.
