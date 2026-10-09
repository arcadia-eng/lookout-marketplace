---
name: orchestrate
description: Orchestrate a fleet of Lookout chats from Claude Code. Delegate, steer, check, and collect results across lanes and machines, and arm the watcher instead of polling. Use when the user wants several Lookout agents, lanes, or a long Lookout task.
---

# Orchestrating Lookout

Lookout chats are the workers. You are the outer agent. The tools are on the `lookout` MCP server. One chat, one lane key, for its whole life.

## Start

1. `lookout_status` once. It is the runnable models, plan usage, projects, and how many chats are in each state.
2. `lookout_machines` when the work might run somewhere other than this machine. Only `online` and `degraded` machines take calls.
3. Give every line of work its own `lane` on `lookout_delegate`. Continue that chat with `lookout_steer` on the same `threadId`. A second delegate opens a second chat.

## Delegate

`lookout_delegate` takes `prompt`, and optionally `workspace`, `projectId`, `model`, `effort`, `machine`, `lane`, `ephemeral`.

- Omit `model` and `effort` unless the user named them or the models skill picked one. The server default is the right default.
- Omit `machine` for this machine. Pass a name from `lookout_machines` to run elsewhere, or `"auto"` when the user wants the load spread (the `vps-workers` skill). An explicit `machine` on one call does not change the session pick.
- Several chats in one repository: `worktree: true` on each, so they never edit the same checkout. `repo` clones the repository onto the target machine first.
- `ephemeral: true` is a throwaway scratch chat. Leave it off when the user should find the chat in the sidebar.
- The workspace for this repository is the current directory.

Prefer the `lookout:worker` subagent (`Agent` with `subagent_type: "lookout:worker"`) when you want the result back and an agent-panel row. The worker waits with `lookout_check` `waitSeconds: 600`. Do not also arm Monitor for that chat: you would be woken twice.

Results of `lookout_delegate`, `lookout_steer`, `lookout_retry` and the other tools that change a chat carry a brief lane (state, summary, held, error kind, next). Pass `full: true` only when you need the whole lane; `lookout_check` reads everything.

## Direct route

When you call `lookout_delegate` yourself and do not want to sit in the wait:

Arm `Monitor` with:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/watch.ts" --thread THREAD_ID
```

`timeout_ms` 1740000, `persistent` false. The script prints one line when the chat settles or needs input, and a re-arm line if it is still working at 29 minutes. It does not poll in a tight loop: it listens to the chat's event stream.

The watcher needs the local app. On the hosted MCP with no local app, use the worker instead.

## While it runs

- One chat: `lookout_check` with `waitSeconds` up to 900 on the local bridge (a hosted or proxied one cuts a wait to 55 and returns early). The call blocks. Do not issue another check of that chat until it returns.
- The fleet: loop `lookout_fleet {waitSeconds: 900, cursor}`, passing back the `cursor` each answer returns (same filters). A call returns as soon as any chat changed state since that answer, with the ids in `waited.changed`, so a chat that finished between two calls is never missed. No polling script. `machines: "*"` covers every machine.
- `interrupted` with `crashResume: "pending"`: Lookout restarted and resumes that delegated turn on its own, once. Leave it. `crashResume: "skipped"` (it went down again inside the resume) or plain `interrupted`: `lookout_retry`. `unfinished` names what died with the turn (a Shell command); the agent is told to rerun it.
- `lookout_steer` refuses an interrupted chat (code `interrupted`): `lookout_retry` continues the cut-off turn, then steer if you have more to say.
- `needs_input`: `lookout_answer` with the user's answer. Do not invent one.
- A follow-up is `lookout_steer`, not a new delegate.
- Stop a chat with `lookout_stop`. Cancel one background run with `lookout_cancel_task`.

## Load and caps

No machine caps or holds delegated turns by default: they start at once however loaded the machine is. A turn waits (state `queued`, `held.reason` and `held.limit` name the limit) only behind a limit the user set: a cap or load hold on its machine (`lookout_configure_machine`: `perMachine`, `perClient`, `perProject`, `loadPerCore`, `memAvailableMinMb`, `memoryPressureLevel`, all 0 until set), a project's own cap (`lookout_configure_project {projectId, admission: {perClient, perProject}}`), or a drain. It starts on its own; never retry a queued chat. Set a limit only when the user asks for one. The user's own sends in the app are never held.

Project folders: `lookout_configure_project {projectId, folders: [primary, ...extra]}` is the full ordered list; the first is the chat cwd and cannot move, the rest are added, removed or reordered.

## Collect

`lookout_fleet` with the thread ids, `brief: false` when you need the replies. `lane.lastReply.text` is the answer. `lane.error` says whether a failure is worth retrying, and `lane.error.next` is the call.

A lane key finds its chat: `lookout_fleet` with `lane`.

A worktree chat's branch is in `lookout_check` `reply.git`. Land it with `lookout_merge_worktree` (into that machine's checkout) or `lookout_push_worktree` (to the remote, then fetch it here).
