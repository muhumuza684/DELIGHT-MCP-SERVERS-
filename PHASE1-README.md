# Phase 1 — Tier 1 MCP Servers

Zero-auth, read-mostly reference servers. Purpose: prove the pipeline
end-to-end and extract the first honest "body" template before any
auth complexity is introduced.

## Contents

- `filesystem-mcp-server/` — scoped local file read/write
- `fetch-mcp-server/` — fetch a URL, return clean Markdown

## Quick start (either server)

```bash
cd <server-folder>
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## What to extract into your reusable "body" after this phase

Diff the two `src/index.ts` files. What's identical:
- McpServer + StdioServerTransport boot sequence
- `toolError()` helper shape
- zod-based inputSchema pattern
- try/catch → MCP-shaped error response pattern

What's different (this is real, non-templatable domain logic):
- filesystem: path-safety boundary (`resolveSafePath`)
- fetch: SSRF guard, HTML→Markdown conversion, pagination

That diff is your evidence for what Phase 6 (extraction) should actually
templatize — don't template anything you haven't seen repeat at least
twice.

## Next: Phase 2 (Tier 2 — API-key auth)

GitHub (read-only mode) and Postgres (read-only mode). Say the word and
I'll build those next as the same zip pattern.
