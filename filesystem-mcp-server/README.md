<!-- mcp-name: io.github.yourorg/filesystem-mcp-server -->
# filesystem-mcp-server

_

Tier 1 reference MCP server — zero auth, stdio transport, scoped file access.
This is the **body template** for future stdio servers: config loading, tool
schemas, consistent error shapes, and a hard security boundary.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `list_directory` | read | List files/folders under the root |
| `read_file` | read | Read a UTF-8 text file (size-capped) |
| `write_file` | **write** | Create/overwrite a text file |
| `create_directory` | **write** | Create a directory |
| `delete_file` | **destructive** | Delete a single file |

All paths are relative to `ALLOWED_DIR`. The server resolves every path and
refuses anything that would escape that root (no `../../` traversal).

## Setup

```bash
npm install
npm run build
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ALLOWED_DIR` | current working directory | Root directory the server may touch |
| `MAX_FILE_BYTES` | `1000000` | Max file size `read_file` will return |

## Run locally (stdio)

```bash
ALLOWED_DIR=/path/to/sandbox node dist/index.js
```

## Register with Claude Desktop / Claude Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": { "ALLOWED_DIR": "/path/to/sandbox" }
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Security notes

- Every path is resolved and checked against `ALLOWED_DIR` before any
  filesystem call — this is the pattern to replicate in any future server
  that touches a scoped resource.
- `write_file` and `delete_file` are side-effecting; a well-behaved client
  should confirm with the user before calling them. Don't relax this.
- Never point `ALLOWED_DIR` at a directory containing secrets you don't want
  an agent to be able to read.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
   (`io.github.yourorg/filesystem-mcp-server`)
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
