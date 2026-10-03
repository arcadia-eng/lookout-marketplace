# Contributing

Thanks for helping shape the Lookout marketplace. This repo holds two
things: the feed (`listings.json` + `listings.schema.json` + validator)
and the listings' source (`servers/lookout-mcp/` today, `plugins/`
later).

## Setup

Bun only (no npm/node needed):

```bash
bun install
bun run validate     # listings.json vs schema + invariants
bun test             # server unit suites + feed gate tests
bun run typecheck    # tsc --noEmit on servers/lookout-mcp
```

CI runs the same three gates on every push and PR: run them locally
before opening one.

## Adding or changing a listing

- One entry in `listings.json` per listing, with per-host `install`
  targets: a listing is never re-listed per host.
- Versions have a single source: the listing's `version` and
  `source.ref` (`lookout-mcp-vX.Y.Z`) come from
  `servers/lookout-mcp/package.json`. Bump the package, tag the release,
  update the feed: never hand-edit the listing version away from the
  package.
- Icons live in `assets/` and are referenced as https URLs pinned to an
  immutable tag, not a branch.
- If the schema allows a shape the feed shouldn't take, extend
  `scripts/validate-listings.ts` and pin the rejection in
  `listings.test.ts`.

## Style

Conventional commits (`feat(lookout-mcp): …`, `fix(feed): …`) with a
body that explains the *why*. Tests are `bun:test`, colocated
(`*.test.ts`). Keep PRs scoped; a feed change and a server change are
separate PRs.

## Security

Please don't open public issues for vulnerabilities: see
[SECURITY.md](SECURITY.md).
