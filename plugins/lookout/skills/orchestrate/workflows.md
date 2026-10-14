# Workflow runs from Claude Code

Read this when the `lookout` server lists `lookout_run_workflow` (the user turned on Settings, Chat, Workflows,
"Workflow runs"; the tools appear within 30 s, no restart). A run is a JavaScript program whose `agent()` calls run as
Lookout agents in one chat's workspace on this machine. Runs do not cross the machine relay.

## Run a Claude Code workflow script in Lookout

Most scripts run unchanged: pass the file's absolute path. Change only these:

| Claude Code | Lookout |
|---|---|
| `model: 'opus'` and other aliases | a model id from `lookout_models` (aliases throw `ModelError`), `"same"` (the host chat's model, the default), `"light"`, or a list of up to 4 ids: the first whose plan is open runs it |
| `isolation: 'worktree'` | `worktree: true`; the call then resolves to `{result, branch}` (branch null when nothing changed). Nothing is merged |
| `agentType` | none: put the role in the brief |
| `workflow({scriptPath})` | `workflow(name, args)` runs saved workflows only (`.lookout/workflows/<name>.js`) |
| `budget.total`, `budget.remaining()` | `budget` is `{agents: {cap, used, remaining}, tokens}` |
| `Promise.race`, `Promise.any` | refused at launch; rewrite |
| about 10 agents at once | `meta.concurrency`, default 8, at most 32: declare it for a wider fan-out |
| 1000 agents per run | 24 without an approval (below); declare `meta.agents` for a bigger run |
| no agent timeout | `timeout` in running minutes, default 120: raise it for agents that wait on long builds or merges |
| subagents read your user-level CLAUDE.md | Lookout agents read the workspace's AGENTS.md, CLAUDE.md, `.lookout/rules`, `.cursor/rules` only: put user-level rules in the brief |

`schema`, `effort`, `label`, `phase`, `parallel`, `pipeline`, `log`, `args` and the determinism bans behave as in Claude
Code. Lookout adds `tools: "read"` (an agent that cannot write; its Shell refuses anything but inspection commands, so
a checker that must run project scripts keeps the default tools), `continue: "<label>"` (carry on a finished agent's
conversation), `fresh: true` (never reuse a result: checks of live state), `ask(question, {choices})` and `warn()`.
`lookout_workflows {reference: true}` prints the whole API.

## Launch and follow

1. A host chat: `lookout_delegate {workspace, lane, model}` with no `prompt` makes one without a model turn. Its model
   is every agent's default.
2. `lookout_run_workflow {threadId, path, args}`. It returns with `runId` once the first agent starts. The run is
   quiet: its end wakes no model in the host chat (`wake: true` asks for that).
3. Arm one watcher per run instead of looping reads:
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/watch.ts" --run <wfr_id> --cursor /tmp/watch-<wfr_id>.json
   ```
   Monitor, `timeout_ms` 1740000, or a background command. One line when the run ends, pauses, waits on a plan reset,
   asks, or one of its agents parks or fails; it exits on an end or an ask. Re-arm with the same `--cursor` file after
   a cut; it prints only what is new.
4. Read the run once at the end: `lookout_workflows {runId}`. A result past 20,000 characters comes in pages
   (`resultTruncated.next` names the `resultFrom` call). A program that returns a compact object (counts, verdicts,
   paths) and writes long findings to a file costs you far less context. One agent's result does not wait for the run:
   `lookout_workflows {runId, agent: <label or agentId>}` returns it whole as soon as that agent is done, in the same
   pages (`resultFrom`).

## While it runs

- `asks` on the run (and `asking` on the host chat's lane): a program's `ask()`, or an approval. Answer with
  `lookout_answer_workflow {runId, option, value}`, relaying the user's answer. A new run declaring more agents than
  the chat's allowance (24 by default) waits for `run` or `raise`; a run that reaches its agents cap waits for a raise
  or `end`. Approve only what the user asked for.
- An agent whose plan is spent parks and goes on at the reset (or on the next model of its list). Leave it.
- Lookout restarting cuts the run; its boot relaunches it: finished agents are reused and cut ones continue their own
  conversation. A run that reads `stopped` resumes with `lookout_run_workflow {resume: "<wfr_id>"}`.
- Stop the run or one agent: `lookout_stop_workflow {runId, agent?, pause?}`. A stopped agent's call returns null and
  the program goes on.
- To change the work: edit the program and `lookout_run_workflow {resume: "<wfr_id>", path}`. Each call is keyed by
  what it asks, so only edited calls and the calls whose prompts embed their results run again; `rerun`, `from` and
  `freshAll` force chosen finished agents.

## Picking models

Set `model` per agent as a fallback list, strongest acceptable first, so a spent plan moves the agent instead of
parking it: for example `["claude-opus-5-5", "gpt-6.1-sol", "grok-4.7"]` for reviews and build agents. Mix two
families across independent review lenses. Use a smaller model for bounded mechanical stages. Never list a model the
user is not fine spending, and never a per-token id unless the user named it. The `models` skill reads the plans.
