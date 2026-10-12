# Phase 6 — create-mcp-server (the generator)

Extracted from evidence across all 10 servers in this catalog, not
designed up front. See create-mcp-server/README.md for usage.

Body: templates/common/ (tsconfig, .gitignore — identical across all 10)
Heads: templates/auth/{none,api-key,oauth}/ — proven by 2-3 servers each
Optional add-on: templates/write-gate-snippet.ts.tmpl — proven by
slack (post_message) and stripe (create_customer/create_refund)

Run: node create-mcp-server/bin/cli.js
