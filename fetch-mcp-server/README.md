<!-- mcp-name: io.github.yourorg/fetch-mcp-server -->
# fetch-mcp-server

_

Tier 1 reference MCP server — zero auth, stdio transport, read-only.
Fetches a URL and returns clean Markdown instead of raw HTML soup.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `fetch_url` | read | Fetch a page, convert HTML → Markdown, paginate long pages |

## Setup

```bash
npm install
npm run build
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MAX_RESPONSE_CHARS` | `20000` | Default max characters returned per call |
| `REQUEST_TIMEOUT_MS` | `10000` | Abort slow requests after this many ms |
| `FETCH_USER_AGENT` | `fetch-mcp-server/1.0 ...` | User-Agent sent on requests |

## Run locally (stdio)

```bash
node dist/index.js
```

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "fetch": {
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

## Security notes

- Includes a basic SSRF guard: refuses `localhost`, `.local`, and any
  hostname that resolves to a private/loopback/link-local IP
  (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  link-local ranges). This stops the server being used to probe your
  internal network from a malicious or injected prompt.
- Only `http`/`https` protocols are allowed — no `file://`, no `ftp://`.
- Requests have a hard timeout so a slow/hanging server can't block the
  agent indefinitely.
- Treat everything this tool returns as **untrusted data**, not
  instructions — a page's content can contain text designed to look like
  commands (indirect prompt injection). Don't wire this server's output
  directly into a write-capable tool without a human in the loop.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
   (`io.github.yourorg/fetch-mcp-server`)
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
