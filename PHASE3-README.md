# Phase 3 — Tier 3 MCP Server (stateful)

First server where persistence design is the real engineering problem.
No new auth head introduced — the point of this phase is state
management alone, so it's easier to reason about before Tier 4 adds
OAuth on top.

## Contents

- `memory-mcp-server/` — store/recall/list/update/forget facts, JSON-file backed

## What this phase proves out (needed before Tier 5's Stripe/Linear server)

- Read-modify-persist without corruption (atomic temp-file + rename)
- Serializing concurrent writes safely
- Keeping the storage engine swappable behind one class boundary

## Quick start

```bash
cd memory-mcp-server
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## Next: Phase 4 (Tier 4 — OAuth 2.1, write-capable)

Slack, Google Drive, Notion — built back-to-back deliberately, so the
real differences between providers' OAuth flows show up before
anything gets templated. This is the most expensive phase in the plan.
Say "4" when ready — it's a bigger build than Phases 1-3, so it may
come as multiple messages/zips.
