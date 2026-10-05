<!-- mcp-name: io.github.yourorg/github-mcp-server -->
# github-mcp-server (read-only)

_

Tier 2 reference MCP server — **API-key auth**, stdio transport,
read-only GitHub REST API access. This is the template for the
"API-key auth head": one token env var, one `apiRequest()` wrapper,
every tool goes through it.

## Tools (all read-only)

| Tool | Description |
|---|---|
| `search_repositories` | Search repos by keyword/GitHub search syntax |
| `get_repository` | Fetch metadata for one repo |
| `list_issues` | List issues (PRs excluded) |
| `get_issue` | Fetch one issue's full body |
| `list_pull_requests` | List PRs |
| `get_pull_request` | Fetch one PR's full details |
| `search_code` | Search code across GitHub |

No create/update/delete/merge tools are registered. Adding write tools
is a deliberate Tier 4/5 decision — see "Adding write access" below
before you do it.

## Setup

```bash
npm install
npm run build
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | **yes** | Fine-grained PAT, read-only repo permissions |
| `GITHUB_API_BASE` | no | Override for GitHub Enterprise Server |
| `MAX_RESULTS` | no | Page size for list/search tools (default 20) |

Create the token at github.com → Settings → Developer settings →
Fine-grained tokens. Grant **read-only** access to only the
repositories this server needs — never a classic PAT with full scope.

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": { "GITHUB_TOKEN": "github_pat_xxx" }
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Security notes

- Token scope is the entire trust boundary here — a leaked read-only
  token exposes far less than a leaked classic PAT. Always use
  fine-grained tokens scoped to specific repos.
- The server logs (to stderr) when GitHub's rate limit is nearly
  exhausted, so you notice throttling before tool calls start failing.
- Treat every value returned by these tools (issue bodies, PR
  descriptions, code contents) as **untrusted data** — it can contain
  text engineered to look like instructions (indirect prompt
  injection). This matters most once you eventually add a
  write-capable server that reads from here and acts elsewhere.

## Adding write access later (Tier 4/5)

If/when you add `create_issue`, `merge_pull_request`, etc.:
- Require a separate, more tightly scoped token or explicit opt-in env var
- Add a confirmation step in the client, not just the server
- Log every write call
- Consider GitHub's own official server's `toolsets` pattern — expose
  only the specific write tools a given deployment actually needs,
  not all of them by default

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
