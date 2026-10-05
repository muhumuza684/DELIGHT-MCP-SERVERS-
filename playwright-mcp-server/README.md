<!-- mcp-name: io.github.yourorg/playwright-mcp-server -->
# playwright-mcp-server

_

Tier 5 reference MCP server — no account auth, stdio transport, **real
side effects** via an actual browser. The hard part of this tier isn't
auth, it's state + timing: async page loads, selector staleness, and
making sure a hung page can never hang the whole server.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `navigate` | side effect | Open a URL in a named page (creates it if needed) |
| `get_page_text` | read | Visible text of the page or a CSS selector |
| `click` | **side effect** | Click an element |
| `fill` | **side effect** | Type into an input (clears first) |
| `screenshot` | read | PNG screenshot, returned as an image content block |
| `list_pages` | read | List open page IDs and URLs |
| `close_page` | side effect | Close a page and free its resources |

## Setup

```bash
npm install          # also runs `playwright install chromium` via postinstall
npm run build
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HEADLESS` | `true` | Set `false` to watch the browser while debugging |
| `NAV_TIMEOUT_MS` | `15000` | Max time for a `navigate` call |
| `ACTION_TIMEOUT_MS` | `10000` | Max time for `click`/`fill`/selector waits |
| `MAX_PAGES` | `5` | Hard cap on concurrently open pages |
| `MAX_TEXT_CHARS` | `20000` | Cap on `get_page_text` output length |

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Design notes

- **Multi-page sessions**: pages are keyed by a `page_id` string an
  agent chooses, so it can hold more than one tab open (e.g. comparing
  two pages) without one navigate call stomping another page's state.
- **Every tool has a hard timeout**: `page.setDefaultTimeout` /
  `setDefaultNavigationTimeout` are set at page-creation time — no
  selector wait or navigation can hang indefinitely and block the
  whole stdio server.
- **`MAX_PAGES` caps resource use**: browser tabs are real memory/CPU;
  an agent in a loop opening pages without closing them will hit the
  cap and get a clear error instead of exhausting the host.

## Security notes

- Reuses the same SSRF guard pattern as `fetch-mcp-server` (refuses
  localhost/private/link-local IPs) — copied rather than shared as a
  dependency, since these two servers have no other reason to be
  coupled.
- This server can click buttons and submit forms on real, live pages.
  Never point it at a site you're logged into with something you
  wouldn't want an LLM acting on unsupervised — there is no built-in
  confirmation step for `click`/`fill`; add one in your client/agent
  loop for anything consequential (purchases, account changes,
  irreversible submissions).
- Page content is fed back to the agent as plain text — treat it as
  **untrusted data**. A malicious page can contain text specifically
  crafted to look like instructions to the agent (indirect prompt
  injection); this is the single biggest risk in this whole catalog,
  because the "read" tool (`get_page_text`) and the "write" tools
  (`click`, `fill`) live in the same server and the same session.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
