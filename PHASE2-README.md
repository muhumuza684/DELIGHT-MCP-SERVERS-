# Phase 2 — Tier 2 MCP Servers (API-key auth, read-only)

Introduces the "API-key auth head": one secret in env, one wrapper
function every tool routes through. Both servers are deliberately kept
read-only — write access is deferred to Tier 4/5 once confirmation-step
and permission-scoping patterns exist.

## Contents

- `github-mcp-server/` — GitHub REST API: repos, issues, PRs, code search
- `postgres-mcp-server/` — Postgres: schema introspection + safe SELECT

## What repeated across both (candidate for the real "auth head" template)

- One required secret env var, checked at boot with a fatal exit if missing
- One wrapper (`apiRequest` / the `run_query` transaction block) that
  every tool goes through — no tool calls the underlying API/DB directly
- Same `toolError()` / `textResult()` response shape as Phase 1

## What did NOT repeat (expected — this is real domain logic)

- GitHub: HTTP + rate-limit header inspection
- Postgres: SQL static analysis + transaction-level READ ONLY enforcement

Two data points isn't enough to safely template the auth head yet —
per the plan, that happens after Phase 4 (Slack/Drive/Notion OAuth),
once you've seen three different *kinds* of auth in practice.

## Quick start (either server)

```bash
cd <server-folder>
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## Next: Phase 3 (Tier 3 — stateful)

Memory server. Say "3" and I'll build it the same way.
