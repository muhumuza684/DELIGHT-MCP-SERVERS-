# create-mcp-server

_

Scaffolds a new MCP server from the body/auth-head templates **extracted
from a real 10-server build**, not designed up front — filesystem,
fetch, github, postgres, memory, slack, google-drive, notion,
playwright, and stripe were all built by hand first (Phases 1-5). This
generator (Phase 6) is the refactor of what turned out to be genuinely
shared across all ten.

## Usage

```bash
node bin/cli.js
```

or, once published: `npx create-mcp-server`.

You'll be asked for:
1. A server name (kebab-case — `-mcp-server` is appended automatically if missing)
2. Your GitHub org/username, for the registry name (`io.github.<org>/<name>`)
3. A display name
4. Which auth head: **none**, **API key**, or **OAuth 2.1**
5. Whether to include a gated write-tool example
6. (api-key/oauth only) the provider name, used to build env var names

It generates a complete, ready-to-build project:

```
your-server-mcp-server/
├── package.json       # deps merged from the chosen auth head
├── tsconfig.json
├── .gitignore
├── .env.example
├── server.json         # MCP registry manifest, pre-filled
├── README.md            # includes the auth head's own notes + a security checklist
└── src/
    ├── index.ts          # McpServer + StdioServerTransport + one example tool
    └── oauth.ts           # only if you chose the OAuth head
```

Then:
```bash
cd your-server-mcp-server
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## The three heads, and what's actually proven behind each

| Head | Proven by (original catalog) | What you get |
|---|---|---|
| `none` | filesystem-mcp-server, fetch-mcp-server | Just the body — no config beyond your own tools |
| `api-key` | github, postgres, stripe | One secret env var, one `apiRequest()` wrapper every tool routes through |
| `oauth` | slack, google-drive, notion | Full PKCE flow, local redirect listener, token caching + refresh, plus a `tokenAuthStyle` escape hatch for providers (like Notion) that don't use the default form-urlencoded token exchange |

The `write-gate-snippet.ts.tmpl` (optional, opt-in) is the
`ALLOW_WRITE`-gated pattern proven by `slack-mcp-server`'s
`post_message` and `stripe-mcp-server`'s `create_customer`/`create_refund`.

## Architecture of this generator

- `bin/cli.js` exports a pure `scaffold(opts)` function separate from
  the interactive prompt loop — the file-generation logic is testable
  without a real terminal/TTY (see the source comments for why this
  split matters: readline over piped/non-TTY input has a known
  EOF-closes-early quirk that has nothing to do with the actual
  scaffolding logic).
- `templates/common/` — the "body," identical in every generated server
- `templates/auth/{none,api-key,oauth}/` — the three heads
- `templates/write-gate-snippet.ts.tmpl` — optional add-on, any head
- `templates/README.base.md.tmpl` + each head's
  `README-auth-section.md.tmpl` — composed together at generation time

## Extending this generator

Found a fourth auth pattern that doesn't fit `none`/`api-key`/`oauth`
after building a couple of real servers with it? Add a new folder under
`templates/auth/<name>/` with the same five files as the existing
heads (`index.ts.tmpl`, `deps.json`, `.env.example.tmpl`,
`README-auth-section.md.tmpl`, plus any extra source files like
`oauth.ts`), then add `"<name>"` to the `askChoice` options and the
`scaffold()` validation list in `bin/cli.js`. Same rule as the original
plan: build it by hand twice for real before templating it here.
