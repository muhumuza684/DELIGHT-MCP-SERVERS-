# Phase 5 — Tier 5 MCP Servers (high-complexity / high-value)

The last phase in the original plan. Both servers here are deliberately
harder than anything before them, for different reasons, and both
exercise the security checklist for real instead of leaving it as a
README bullet list.

## Contents

- `playwright-mcp-server/` — browser automation: navigate, read, click, fill, screenshot
- `stripe-mcp-server/` — payments: read customers/charges, gated customer creation and refunds

## Why these two, and in this order

- **Playwright** is hard because of *state and timing*, not auth — no
  account credentials at all, but async page loads, selector
  staleness, and the need for hard timeouts everywhere so a hung page
  can't hang the whole server.
- **Stripe** is hard because of *stakes*, not technical complexity —
  the auth is plain API-key (the simplest kind in this whole catalog),
  but a wrong write call moves real money. This is where three
  independent safety layers actually matter: a live-mode boot guard,
  a server-level write gate, and a per-call confirmation flag on the
  one truly hard-to-reverse action (refunds).

## The full 10-server catalog, in build order

| Tier | Server | Auth | Effect |
|---|---|---|---|
| 1 | filesystem | none | read + scoped write |
| 1 | fetch | none | read |
| 2 | github | API key | read |
| 2 | postgres | API key (conn string) | read |
| 3 | memory | none | stateful read/write |
| 4 | slack | OAuth 2.1 | read + gated write |
| 4 | google-drive | OAuth 2.1 | read |
| 4 | notion | OAuth 2.1 | read |
| 5 | playwright | none | side-effecting |
| 5 | stripe | API key | read + gated write |

This set deliberately touches every axis from the original plan:
stdio→remote-ready patterns, no-auth→API-key→OAuth, read-only→
stateful→write-capable, thin-wrapper→multi-layered-safety.

## What Phase 6 (extraction) should look like now

You have real evidence across 10 servers, not assumptions, for:
- the "body" template (McpServer/StdioServerTransport boot, `toolError`/
  `textResult` shape, zod schemas) — identical in all 10
- the "API-key head" (one secret, one wrapper function) — proven across
  github, postgres, stripe
- the "OAuth head" (`oauth.ts` + its `tokenAuthStyle` escape hatch) —
  proven across slack, google-drive, notion
- the "gated write" pattern (`ALLOW_WRITE`, confirm flags) — proven
  across slack and stripe, worth carrying into any future write tool

Pull these into a real `create-mcp-server` CLI generator now — not
before, since every piece of it is a refactor of code that's actually
been built and run, not a guess.

## Quick start (either server)

```bash
cd <server-folder>
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```
