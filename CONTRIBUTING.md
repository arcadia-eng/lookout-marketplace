# Contributing a listing

A PR adds or updates one listings.json entry. Server work lives under servers/lookout-mcp/ and is a separate PR. plugins/lookout/ is published from Lookout's own source, so report plugin problems as issues instead of PRs.

1. Branch from main.
2. Edit the one entry.
3. Bump a server version only in package.json and cut lookout-mcp-vX.Y.Z.
4. Put icons in assets/ and pin the URL to a tag.
5. Run bun run validate and bun test.
6. Open the PR.

- unique kebab-case id
- version matches the package and the tag
- validator green
- icon pinned to a tag
- no secrets

See SECURITY.md.
