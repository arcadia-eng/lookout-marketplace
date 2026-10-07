---
name: vps-workers
description: Run Lookout chats on the user's Linux VPSs instead of this Mac, to spread CPU and memory. Enroll a VPS as a Lookout machine, get a repository onto it, place chats by load, wait, collect, push and merge their work, and clean up. Use when the user wants Lookout agents on a VPS, more parallel agents than this Mac should carry, or load balanced across machines.
---

# Lookout agents on a VPS

A VPS is a worker of the user's Lookout account: it runs whole Lookout chats (loop, tools, subscriptions) and reports its load. This Mac is the control plane: you place work from here. Lookout Agents (the app's orchestrator agents) live only on the Mac; a VPS runs coding chats.

## 1. Enroll a fresh VPS (once)

0. `lookout_machines` first: a box already listed is enrolled (go to 3; `outdated` means upgrade, never re-enroll). A box already running a Lookout node as the user `lookout` for something else: add `LOOKOUT_USER=<another name>` to the line below, since the line takes over whatever runs as its user.
1. `lookout_install_line {name: "vps-2"}` gives the line. It names the user's account (not a secret), so the request to join reaches only their devices.
2. Run it as root over ssh: `ssh root@HOST '<line>'`. As root it creates the user `lookout` and installs everything as that user, with a lingering systemd user service. On a box shared with CI, add `LOOKOUT_MEMORY_MAX=6G LOOKOUT_CPU_WEIGHT=20` before `sh`. It never prompts: it prints a code and a `lookout://add/...` link and exits; the service finishes the join once it is approved (`ssh root@HOST 'sudo -iu lookout lookout status --json'` shows `state: "waiting"`, `code`, `addLink`). Then `lookout_open_add_link {link}` brings the request up in Lookout on this Mac with the code already checked, and tell the user: "Approve vps-2 in Lookout." That click is the one step that needs them, by design (the vault is zero-knowledge: only a member device can add a machine). `lookout_machines` lists it under `waiting` until then.
3. `lookout_machines`: the new machine is `online` with a `capacity` block and no `outdated`.
4. `lookout_doctor {machine: "vps-2"}`: `providers.connected` lists the vault's providers; read `problems`. Provider sign-ins reach a VPS only this way, through the vault sync: never copy an auth file, a token or a copy of a sign-in there (scp, a heredoc, a project's `setup`, a chat's prompt). `lookout_models {machine: "vps-2"}` lists the model ids that run there.
5. Git, when the work clones private repositories or pushes. Ask the user for a token (a fine-grained one scoped to the repositories), then:
   `printf %s "$TOKEN" | ssh root@HOST 'sudo -iu lookout lookout git setup --host github.com --token-stdin'`
   `ssh root@HOST 'sudo -iu lookout lookout git setup --name "NAME" --email EMAIL'`
   (`--host` is the forge's host; `--user` defaults to `x-access-token`). A missing credential shows up as `git_auth` with this command in `fix`.
6. Toolchains the projects build with (cargo, bun, node, a Postgres client): install them as the `lookout` user the usual way (`ssh root@HOST 'sudo -iu lookout sh -c "curl --proto =https -sSf https://sh.rustup.rs | sh -s -- -y"'`, bun's or nvm's installer, `apt-get install -y postgresql-client` as root), then restart the service: `ssh root@HOST 'systemctl --user -M lookout@ restart lookout'`. Lookout adopts the login shell's PATH and env at start (`~/.cargo/bin`, `~/.bun/bin`, nvm/fnm shims), so never edit the unit, symlink binaries or hand-wire PATH. Declare what a project needs with `lookout_configure_project {projectId, requires: ["cargo", "bun", "psql"]}` (and `path: ["~/.foundry/bin"]` or `env: {...}` for anything no login shell sets; committed in `.lookout/worktree.json`, so no secrets), then `lookout_doctor {machine: "vps-2"}`: `toolchains[].missing` and `problems` name what is still absent; `shellEnv.source` is `login-shell` when the adoption worked.
7. Optional caps: `lookout_configure_machine {machine: "vps-2", perMachine: 2}`.

A provider "held back" on the VPS (`lookout_doctor` problems and `providers.heldBack`, or `lookout status` on the box): it refused an older copy than it already had from the account (a rollback guard). The line names the command; run `ssh root@HOST 'sudo -iu lookout lookout providers use-account <provider>'` only when the account's copy is the one to keep (the user reset or re-signed it), else `keep <provider>`. A reset or re-created vault no longer trips it.

An existing machine listed `outdated` is upgraded from this Mac: `lookout_configure_machine {machine: "vps-2", upgrade: true}` (or `lookout upgrade --on vps-2`). It parks running chats, installs the latest signed release and restarts; the parked chats resume. `ssh root@HOST 'sudo -iu lookout lookout upgrade'` is the same install when you are already on the box. Waiting starts survive.

## 2. Place work

- Keep on this Mac: work on the user's own checkout, anything needing a process running here, quick iterations.
- Put on a VPS: independent, CPU-heavy or parallel work.
- `lookout_delegate {machine: "auto", repo: "https://github.com/acme/app", worktree: true, lane: "<key>", model: "<id>", prompt}`. Always pass `model`: a project cloned on a VPS starts on the catalog default, which may not run there (refused as `model_unavailable` with the ids that do). `auto` picks the machine with the most headroom that runs the model. The result's `placement` says where and why (and why not the others). Name a machine instead when the user did.
- Several chats in one repository: `worktree: true` on every delegate, so each works on its own branch. A project's `.lookout/worktree.json` (`lookout_configure_project {setup, teardown, path, env, requires}`, or Project settings) runs on the machine that creates the worktree: `setup` before the chat starts (install dependencies, copy `.env`), `teardown` when the worktree is removed. A failed setup fails the start and the chat shows the output. After the first clone, `projectId` from the result reuses the project on that machine; pass that machine too (`projectId` names a project on one machine; `auto` refuses it).
- `no_machine` means nothing can take it now. Read each `rejected[].reason`: `at_capacity` or `memory_pressure` means wait or name a machine (it queues there); `outdated` means upgrade it; `model_unavailable` means another model; `cordoned` means that machine is not taking new placements (running chats there continue; `lookout_configure_machine {cordon: false}` lifts it); `draining` means it is parking live chats for a restart.
- `delivered: "queued"` (state `queued`): a cap or memory pressure holds it; it starts on its own when a slot frees. Never retry or re-delegate it.
- A chat stays on its machine. Follow-ups (`lookout_steer`, `lookout_check`, `lookout_answer`) need no `machine`.

## 3. Wait and collect

- `lookout_fleet {machines: "*", waitSeconds: 900, cursor}` sleeps until any chat on any machine changes (pass back each answer's `cursor` so a change between calls answers at once); it answers at once with `waited.idle` when nothing is working or queued. A remote machine's wait rides relayed long-polls of up to 55 s, looped for you. `lookout_check {threadId, waitSeconds: 600}` for one.
- `needs_input`: `lookout_answer` with the user's answer. `quota`: `lookout_retry {threadId, model}`. `interrupted` (the machine crashed or restarted mid-turn): `lookout_retry {threadId}`.
- The report: `lookout_check` `reply.text`. Its `reply.git` is the branch: `ahead`, `dirty`, `pushed`, `merged`. The diff: `lookout_changes {threadId, scope: "chat"}`.
- A relay `timeout` (`retry: check_first`) may have run: check before you retry. A VPS cut off from the account keeps working; its chats read normally once it is back.

## 4. Integrate

- `lookout_push_worktree {threadId}` pushes the branch to the project's remote with the VPS's credential. Then on this Mac: `git fetch origin <branch>` and merge, or open `compareUrl`.
- `lookout_merge_worktree {threadId}` merges it into the VPS checkout instead, to stack several chats there. A `merge_conflict` leaves the checkout unchanged: steer that chat to `git merge main`, resolve and commit, then merge again. No tool pushes the checkout itself: push the last merged chat's branch (it carries the others). A later clone result's `ahead` counts what was merged there and not pushed.
- A dirty worktree: steer the chat to commit first.

## 5. Clean up

- `lookout_archive {threadIds, removeWorktree: true}` removes worktrees whose commits are merged or pushed and says why it kept any.
- `lookout_delete_project {machine, projectId}` for scratch projects. Its chats' clean, merged or pushed worktrees go with it; `worktreesKept` names any holding unpushed work. A cloned checkout stays on disk (reused next time); remove it on the box if it was scratch. Leave the user's own repositories.
