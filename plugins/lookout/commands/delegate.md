---
description: Hand a task to a Lookout agent and get its result back
argument-hint: "[--model id] [--effort level] [--machine name] [--lane key] [--ephemeral] [--background] [--direct] <brief>"
---

Hand this to Lookout: $ARGUMENTS

## Flags

Parse these out of the arguments and remove them from the brief.

| Flag | Effect |
|---|---|
| `--model <id>` | `lookout_delegate` `model`. Omit when the user did not name one. |
| `--effort <level>` | `lookout_delegate` `effort`. Omit when they did not name one. |
| `--machine <name>` | Run on that machine (`lookout_machines` lists names). Omit for this machine. |
| `--lane <key>` | Lane key. Without it, a short slug from the brief. |
| `--ephemeral` | Throwaway chat, archived when it finishes. |
| `--background` | Bridged route, but do not wait on the agent row. |
| `--direct` | No agent row. You call `lookout_delegate` here and arm Monitor. |

`--background` and `--direct` together are a mistake: say so and stop.

If no brief text remains, ask what Lookout should do and stop.

The workspace is the current directory, passed as `workspace`, unless the user named another path.

## Bridged route (the default)

1. Call `Agent` with `subagent_type: "lookout:worker"`.
2. The prompt is the brief plus one line of the controls you parsed, for example `model "fixture-hello", machine "vps", lane "export"`.
3. Wait for the agent unless `--background` is set. Its final message is the result. Return it verbatim.
4. Do not arm Monitor on this route. The agent finishing is the notification.

## Direct route (`--direct`)

1. Call `lookout_delegate` with the brief and the controls. Do not wait inside a poll loop.
2. Arm `Monitor` with command `sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/watch.ts" --thread <threadId>`, `timeout_ms` 1740000, `persistent` false, and a description that names the thread id. That exits on its own when the chat settles or needs input, and just before 30 minutes if it is still working (arm it again then).
3. Report the thread id and the lane. Do not call `lookout_check` in a loop.

The watcher only sees the local app. If this session is on the hosted MCP and the local app is down, do not arm it: use the bridged route instead.
