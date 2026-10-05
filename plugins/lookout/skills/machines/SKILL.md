---
name: machines
description: See and pick Lookout machines (this Mac, other Macs, a VPS). Use when work should run on a specific machine, or the user asks which machines are online.
---

# Machines

`lookout_machines` lists this account's machines and how each is right now: `online`, `degraded`, `asleep`, `offline`, `signed-out`. `presenceDetail` is the sentence to show the user. Do not rephrase it into a different cause. Each reachable machine also carries `capacity` (chats running and queued against its cap, load per core, free memory, `admitting` or the `hold` reason) and `version`; `outdated` lists what an older Lookout there lacks. `suggested` is the machine `machine: "auto"` would pick. A machine whose load average is above 1.5 per core, or with under 3 GB available memory, is never suggested (`notEligible` says `high_load` or `memory_low`), even when an older Lookout there still admits.

- `online` and `degraded` take calls. Anything else fails at once, with that sentence as the reason.
- `thisMachine: true` is the app you are talking to.
- Pass `machine` on a single `lookout_delegate` or `lookout_steer` to run that call there. It does not stick.
- `lookout_use_machine` sticks for the MCP session (or the whole connection, when the client has no session id). The tool's reply says which. Pass `local` to come back to this machine.
- A chat stays on the machine it was started on. Steering it from elsewhere still reaches it; you do not move it by selecting a different machine.
- `lookout_fleet` without `machine` is this machine's chats. Pass `machine` to list another's.

Do not select a machine the user did not name, unless they asked you to balance load or to use their VPSs: then pass `machine: "auto"` on each new `lookout_delegate` and let placement choose (the result's `placement` says why). Do not fan one task out across every machine. `lookout_fleet {machines: "*"}` reads every machine at once. Setting up a VPS, repositories there, and getting work back: the `vps-workers` skill.
