# Gmail

Search, read, draft and organize your mail from Lookout.

Lookout connects to Google's hosted Gmail MCP server, `https://gmailmcp.googleapis.com/mcp/v1`, and signs in with your Google account. There is no code here: the tools are Google's.

## Add

In Lookout, open Settings, Connectors, Gmail and choose Add. Pick a Google account and allow access. Link another account the same way.

## What it can do

- Read: search threads, read threads, messages and drafts, list labels
- Draft: new drafts and threaded replies
- Organize: labels, archive, read and unread, trash and spam

It can't send. The agent drafts and you send from Gmail.

## Access

Lookout asks Google for `openid`, `email` and `gmail.modify`. Grants stay on your devices, encrypted, and sync only as ciphertext. Unlink revokes the grant at Google.

## Availability

Preview. Google's Gmail MCP server is in Developer Preview.

## License

MIT. See [LICENSE](../../LICENSE). Gmail and its logo are trademarks of Google LLC.
