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

`lookout_delegate` takes `prompt`, and optionally `workspace`, `projectId`, `title`, `model`, `effort`, `multitask`, `machine`, `lane`, `ephemeral`, `onQuota`, `fallbacks`, `schema`.

- `title` is the chat's row in the sidebar: 2 to 6 words, at most 40 characters ("Fix the login redirect"). The goal goes in the prompt. A longer title is not used: the chat titles itself from its first exchange and the answer's `titleNote` says why. A `lookout_configure` rename over 40 characters is refused (`title_too_long`) and nothing in the call changes. Omit it and Lookout titles the chat.

- Omit `model` and `effort` unless the user named them or the models skill picked one. The server default is the right default.
- Pass `multitask: false` for one line of work: most delegates, and every lane of a scan plan. The chat does the work itself and can still start Task workers. `multitask: true` makes the chat a coordinator over background workers that cannot delegate, so one line of work pays for three model layers reading the same brief, and each part costs a worker exit, a coordinator round and a resume. Pass true only when the work has two or more parts that can run at the same time in separate contexts. Omitted, it follows the project's setting, which may be on.
- Omit `machine` for this machine. Pass a name from `lookout_machines` to run elsewhere, or `"auto"` when the user wants the load spread (the `vps-workers` skill). An explicit `machine` on one call does not change the session pick.
- Several chats in one repository: `worktree: true` on each, so they never edit the same checkout. `repo` clones the repository onto the target machine first.
- `ephemeral: true` is a throwaway scratch chat. Leave it off when the user should find the chat in the sidebar.
- A lane that runs while nobody watches passes `onQuota: "wait"`: a spent plan or a rate limit parks it (state `parked`) and it goes on by itself at the reset, through a restart too. `onQuota: "fallback"` with `fallbacks` (up to 4 model ids, only ones the user is fine spending) moves it at once to the first listed model whose plan is open, and waits when none is. Without either the chat stops at the wall (`quota`) for you. Never list a model the user didn't pick: nothing outside `fallbacks` is used.
- A review or a check whose answer you will read as data passes `schema` (a JSON Schema object, top level an object): the chat ends its turn by submitting a matching object, and the lane carries it as `result` (`resultError: "schema"` when it ended without one). Read `result`, never parse the prose.
- A lane in the lookout repo runs in the tree `bun scripts/lane.ts new` made for it, never in the current directory ("Lanes in the lookout repo", below). Another repository's chat works in the current directory, with `worktree: true` when several share it.
- A folder no project has yet becomes one only where the user lets this client add projects. Without that, `lookout_delegate` and `lookout_create_project` refuse it with `grant_needed` (or `outside_grant` for a folder outside what was allowed), and `setting` names the place in Lookout (`Settings > App access > Add projects > <client>`). Ask the user to allow it there, then call again; meanwhile use an existing `projectId` from `closest` or `lookout_projects`. Never route around it through another folder.

For background work, do not spend a subagent per chat: delegate, then arm the fleet watcher once per batch (next section). The `lookout:worker` subagent is only for one chat you want to block on inside the agent panel (it waits with `lookout_check` `waitSeconds: 600`); do not also arm a watcher for that chat, you would be woken twice.

Results of `lookout_delegate`, `lookout_steer`, `lookout_retry` and the other tools that change a chat carry a brief lane (state, summary, held, error kind, next). Pass `full: true` only when you need the whole lane; `lookout_check` reads everything.

## The watcher: one per batch

When you delegate a batch and do not want to sit in the wait, give the batch's lane keys one prefix (`lane: "oct9-reviews-diff"` and so on), then arm one watcher for the whole batch, not one per chat:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/watch.ts" --fleet --lane-prefix oct9-reviews --cursor /tmp/watch-oct9-reviews.json --machines "*"
```

Monitor, `timeout_ms` 1740000, `persistent` false (or run it as a background command: its exit wakes you). One line per chat that settles, needs input, hits a quota wall (with the reset time), starts waiting for its plan (`waiting for <model>'s plan until <time>`: it keeps watching, the chat goes on by itself) or has a workflow run asking, on any machine. It exits when the batch settles or a chat needs an answer, and prints a re-arm line at 29 minutes if work is still going; re-arm with the same `--cursor` file and it prints nothing twice.

- `--machines "*"` covers this machine and every reachable one; name machines (`--machines denar-build,mac`) or watch one (`--machine denar-build`) instead. A remote machine's lines carry its name.
- Without `--lane-prefix` it watches every chat on the machine, including the user's own; a prefix is the batch.
- One workflow run (Workflows lab): `--run <wfr_id>` instead of `--fleet` (`--machine <name>` for a run on another machine); a line when it ends, pauses, waits on a plan reset, asks, or one of its agents parks or fails, and it exits on an end or an ask.
- One chat only: `--thread <id>`.
- The watcher needs the local app. On the hosted MCP with no local app, block on `lookout_fleet {waitSeconds}` instead.

## Workflow runs

When the `lookout` server lists `lookout_run_workflow` (the user turned workflow runs on in Lookout), staged programs of agents run in Lookout: a Claude Code workflow script mostly runs unchanged. Read `workflows.md` in this skill's folder before the first launch: what to change in a script, launching from a host chat, the watcher, answers, resume, and model picks.

## While it runs

- One chat: `lookout_check` with `waitSeconds` up to 900 on the local bridge (a hosted or proxied one cuts a wait to 55 and returns early). The call blocks. Do not issue another check of that chat until it returns.
- The fleet: loop `lookout_fleet {waitSeconds: 900, cursor}`, passing back the opaque `cursor` each answer returns with the same filters. A call returns as soon as any matching chat changed state, including one outside the page, with ids in `waited.changed`. Read `nextPage` with `page` on one machine and keep the returned cursor for the next watch: changes during paging still wake it. `cursorReset: true` means the snapshot expired or the server restarted; resynchronize all pages before deciding the batch settled. No polling script. `machines: "*"` covers every machine. The watcher reads every snapshot page and stores opaque cursors plus deduplication marks in its `--cursor` file; never decode a fleet cursor.
- `interrupted` with `crashResume: "pending"`: Lookout restarted and resumes that delegated turn on its own, once. Leave it. `crashResume: "skipped"` (it went down again inside the resume) or plain `interrupted`: `lookout_retry`. `unfinished` names what died with the turn (a Shell command); the agent is told to rerun it.
- `lookout_steer` refuses an interrupted chat (code `interrupted`): `lookout_retry` continues the cut-off turn, then steer if you have more to say.
- `needs_input`: `lookout_answer` with the user's answer. Do not invent one.
- `parked`: the chat waits for its plan's reset and goes on by itself. Do not poll it, retry it or re-delegate it; the watcher or `lookout_fleet` tells you when it ends. `lookout_stop` ends the wait.
- `quota` (a chat without `onQuota`): `lookout_retry {threadId, model}` moves it now, `lookout_retry {threadId, wait: true}` waits for the reset (a reset already past goes at once).
- `open-todos` or `incomplete` on a settle is not done: it stopped with todos open and nothing running (`lane.openTodos` has the count and its last line) or a limit cut the turn (`lane.lastStopReason` says which). Steer it to go on, or ask for its report.
- A follow-up is `lookout_steer`, not a new delegate.
- Stop a chat with `lookout_stop`. Cancel one subagent with `lookout_cancel_task`.
- `lookout_tasks {threadId}` keeps active tasks and five recent finished summaries, with counts for the rest. Use `state`, `filter`, `limit` and `cursor: nextCursor` for older tasks. Workflow tasks contain compact agent status only: read `lookout_workflows {runId}` for progress and results, not the task's step list. A running workflow agent's old quota reason is not a live wait; `continued` counts its continuations. Model skips are grouped with the affected-call count.
- `lookout_configure` returns a brief lane plus the settings and chat fields that changed, not a raw thread. `full: true` returns the complete lane.

## Load and caps

No machine caps or holds delegated turns by default: they start at once however loaded the machine is. A turn waits (state `queued`, `held.reason` and `held.limit` name the limit) only behind a limit the user set: a cap or load hold on its machine (`lookout_configure_machine`: `perMachine`, `perClient`, `perProject`, `loadPerCore`, `memAvailableMinMb`, `memoryPressureLevel`, all 0 until set), a project's own cap (`lookout_configure_project {projectId, admission: {perClient, perProject}}`), or a drain. It starts on its own; never retry a queued chat. Set a limit only when the user asks for one. The user's own sends in the app are never held.

Project folders: `lookout_configure_project {projectId, folders: [primary, ...extra]}` is the full ordered list; the first is the chat cwd and cannot move, the rest are added, removed or reordered.

## Agents

`lookout_configure_agent` sets up one of the user's named agents (not a chat): `agent` by id or exact name, and any of `name`, `description`, `instructions`, `section` (id or exact name, or null), `projects` (project ids, first is its default), `fallbacks` (up to 4 `{model, effort}`, model ids and levels from `lookout_models`), `notify`, `showWork`. Only the fields you pass change. Moving into a Lookout agent means writing the instructions it lives by, binding its projects, and setting its fallbacks in one call.

- It needs the user's per-client permission on that machine, off by default. A refusal is `grant_needed`, and `setting` names the place (`Settings > App access > Configure agents > <client>`). Ask the user to allow it there, then call again.
- Limits, allowed models, pause, lock, memory switches and full autonomy are the user's in the app: the tool cannot set them, and the server refuses them to terminal and MCP callers alike.
- Every change is attributed to this client (the agent's transcript notice and the action log name it). Set an agent up the way the user asked, no further.

## Collect

`lookout_fleet` with the thread ids, `brief: false` when you need the replies. `lane.lastReply.text` is the answer. `lane.error` says whether a failure is worth retrying, and `lane.error.next` is the call.

A lane key finds its chat: `lookout_fleet` with `lane`.

## Before the session ends: hand chats off

A chat you started that still matters when this session ends would be left with nobody watching it. Hand it to a Lookout agent with `lookout_handoff {threadIds, agent}` (or `lanePrefix` for a batch; `machine` when the chats live elsewhere): the agent hears each one once it settles, steers it, and reports to the user. You hand only chats your client started, on another machine too when you started them there from this device; `not_yours` means another client's (or one no client attested starting), which only the user hands (the chat's menu, Hand to, or Hand by lane prefix for a batch). The lanes then carry `handedTo`; your own `lookout_steer` still reaches them, as the user's message, so tell the agent rather than steering past it.

A worktree chat's branch is in `lookout_check` `reply.git`. Land it with `lookout_merge_worktree` (into that machine's checkout) or `lookout_push_worktree` (to the remote, then fetch it here).

The lookout repo lands a remote chat's work from this Mac: the chat pushes its branch (`lookout_push_worktree`), then you, or a Mac-side chat, runs `bun scripts/ship.ts --branch <branch>` from any checkout. That fetches the branch, checks it in a throwaway worktree of its own and queues it like a lane ship; it refuses in one line (nonzero exit) when origin has no such branch, its tip is already on main, or the check is red, and exits 2 when the branch does not merge into main (merge origin/main into it, push, and run it again). `bun scripts/ship.ts --status <id>` reads the outcome.

## Lanes in the lookout repo

Make the lane, then delegate into it. From the owner checkout, `bun scripts/lane.ts new <name>`; its last line is `delegate into: workspace <tree>`. Then `lookout_delegate {workspace: "<tree>", lane: "<name>", multitask: false, prompt, ...}`, without `worktree: true` (lane.ts made the tree), and with `multitask: true` only when the brief has parts that run at the same time ("Delegate", above). The chat joins the lookout project with the tree as its folder, so its Shell, Read, Grep, rules, checkpoints, Changes and Task workers all work there. The work order says the chat's folder is its lane tree, and that the chat never runs `lane.ts new` itself, except `lane.ts new <name> --branch <branch>` to take back a red. Its first `ship.ts` records it as the lane's owner, so the landing's outcome comes back to it.

A red that wakes the chat after its `lane.ts done` removed the tree runs that turn in the project folder, and the turn says so. The chat takes the lane back there with `lane.ts new <name> --branch <branch>`, which puts the tree at the same path, and its next turn runs in the tree again.

## Landings in the lookout repo

A Lookout chat (or its Task worker) that ships a lane hears the landing itself: the server wakes it with the outcome as a notice, a red with its reason and the `lane.ts new <name> --branch <branch>` that takes it back. So a delegated chat ships, runs `lane.ts done`, reports `queued <id>` and ends its turn; never tell it to wait on `--status` or poll, and do not re-delegate a red: its chat already took it back. You, outside Lookout, have no such wake: follow a landing of your own with `bun scripts/timeout.ts 580 bun scripts/ship.ts --status <id> --wait` as a background command, armed again while it is still queued, and read the reds nobody shipped again with `bun scripts/ship.ts --status` on main.
