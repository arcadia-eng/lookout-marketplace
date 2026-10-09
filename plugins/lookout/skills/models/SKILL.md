---
name: models
description: Pick a Lookout model from provider quotas. Use when the user wants a model chosen by remaining plan, a free model, or before a long Lookout run that must not die on an exhausted window.
---

# Pick a model by quota

The canonical document is `GET /api/providers` on the local Lookout app (`http://127.0.0.1:8789/api/providers`, or `LOOKOUT_URL`), with the header `x-lookout-session: <the contents of ~/.lookout/app-session.key>` (the app answers no request without it). One shape for every provider: `connection`, `plan`, `meters` (`leftPercent`, `exhausted`, `resetsAt`), `metered`, `accounts`. No tokens, no keys.

- `?refresh=none` reads the local snapshot and does not dial the providers.
- The default re-reads what is stale.
- `?refresh=force` re-reads every signed-in account's windows now.

`lookout_usage` is that same read, trimmed to what a run decides on (`connection`, windows, `leftPercent`, `resetsAt`). Prefer it. Fetch the raw document only when you need accounts, custody, or the credential's kind (the route does not send a secret).

`lookout_models` is what can run right now, with each model's effort ladder. An id that cannot run is refused, and the error lists the ids that can.

## How to choose

1. Drop `expired`, `refused`, and `disconnected`.
2. Drop `exhausted` (a window is spent until `resetsAt`) unless the user explicitly wants that provider.
3. Among the rest, prefer the provider whose tightest window has the most `leftPercent`.
4. A `connected` provider with `metered: false` (no plan windows) is the right default for a trivial task. `lookout_models` shows what it can run. Do not invent a model id; use one from that list. OpenCode's free catalog is the usual unmetered choice when it is connected.
5. Pass the chosen id as `model` on `lookout_delegate`. Omit `effort` to take the model's own default, unless the user named a level from that model's ladder.

When the user did not ask for a model, omit `model`. The server default is a choice, and overriding it without a reason spends the wrong plan.
