---
description: List Lookout machines, and optionally select one
argument-hint: "[name to select]"
---

Machines on this Lookout account.

Arguments: $ARGUMENTS

Call `lookout_machines` and report each machine's name, presence, and whether it is this machine. Use the `presenceDetail` text as written. Do not invent a reason.

If the arguments name one machine, call `lookout_use_machine` with that name and report what it returned, including a warning that calls will fail when the machine is not online or degraded. If the arguments are empty, do not select anything.

`local` clears the selection back to this machine. Pass it only when the user asked for this machine.
