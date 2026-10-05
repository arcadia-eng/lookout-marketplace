---
description: Send a follow-up into an existing Lookout chat
argument-hint: "<threadId> <message>"
---

Steer a Lookout chat.

Arguments: $ARGUMENTS

The first token is the thread id (`lookout_delegate` or `lookout_fleet` returned it). The rest is the message. If either is missing, ask for it and stop.

Call `lookout_steer` with that `threadId` and `text`. If it refuses with code `interrupted` (a restart cut the turn off), call `lookout_retry` with that `threadId` instead, then steer. Then call `lookout_check` once with `waitSeconds: 600`.

- If the chat settled, return `lane.lastReply.text` verbatim and the state.
- If it still needs input, return the question verbatim and stop.
- If it is still working, report the thread id and the state. Do not poll. Tell the user they can arm `sh "${CLAUDE_PLUGIN_ROOT}/scripts/bun.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/watch.ts" --thread <threadId>` with Monitor, or wait with another `lookout_check`.
