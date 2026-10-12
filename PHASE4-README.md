# Phase 4 — Tier 4 MCP Servers (OAuth 2.1, write-capable)

The expensive phase. Three real OAuth 2.1 servers, built back-to-back on
purpose, so the "OAuth auth head" template is extracted from evidence
instead of assumption.

## Contents

- `slack-mcp-server/` — channels, history, users, gated message posting
- `google-drive-mcp-server/` — search/list/read files, Docs/Sheets export
- `notion-mcp-server/` — search, pages, page content, database queries
- `oauth.ts` — the shared generic OAuth 2.1 PKCE helper (also copied
  into each server's `src/`)

## What actually turned out to be shared (the real "OAuth head")

- PKCE generation, local loopback redirect listener, state/CSRF check,
  on-disk token persistence with `0600` permissions, refresh-before-expiry
  logic — all identical across all three, unchanged code
- Same `toolError()` / `textResult()` response shape as every prior phase

## What did NOT turn out to be shared — this is the actual finding

| Difference | Slack | Google Drive | Notion |
|---|---|---|---|
| PKCE | No | Yes | No |
| Refresh tokens | Only if app has token rotation enabled | Yes (needs `access_type=offline`+`prompt=consent`) | Effectively none — long-lived token instead |
| Token exchange auth | client_secret in form body | client_secret in form body | **Basic auth header + JSON body** (broke the generic assumption) |
| Failure signaling | HTTP 200 + `{ok:false}` | Standard non-2xx | Standard non-2xx |
| Access model | OAuth scopes | OAuth scopes | Capability + explicit per-page sharing, no real scopes |

That Notion row is the important one: it's why `oauth.ts` grew a
`tokenAuthStyle` option instead of being finalized after Slack alone.
If you'd templated the auth head after just the Slack build, Notion
would have silently failed token exchange — this is the concrete
version of the "don't template after one example" rule from the plan.

## Quick start (any server)

```bash
cd <server-folder>
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Each server prints an authorization URL to stderr on first tool call —
open it, approve access, come back. Tokens are cached in a local
`.{provider}-tokens.json` file after that.

## Next: Phase 5 (Tier 5 — high-complexity / high-value)

Playwright browser automation, then a payments or issue-tracking
server (Stripe or Linear/Jira — your call which first). This is where
the security checklist (tool poisoning, confused deputy, injection via
tool outputs) gets exercised for real, since these are the
highest-stakes write servers in the catalog. Say "5" when ready.
