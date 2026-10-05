<!-- mcp-name: io.github.yourorg/memory-mcp-server -->
# memory-mcp-server

_

Tier 3 reference MCP server — no external auth, stdio transport,
**stateful**. First server in the plan where persistence design is the
actual engineering problem, not pass-through API logic.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `remember` | write | Store a new fact, optionally tagged |
| `recall` | read | Keyword search across stored memories |
| `list_memories` | read | List memories, newest-updated first, filterable by tag |
| `update_memory` | write | Edit an existing memory's content/tags |
| `forget` | **destructive** | Permanently delete a memory by id |

## Setup

```bash
npm install
npm run build
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MEMORY_FILE` | `./memory.json` | Where memories are persisted |
| `MAX_ENTRIES` | `5000` | Hard cap to stop unbounded growth |

## Run locally (stdio)

```bash
MEMORY_FILE=/path/to/memories.json node dist/index.js
```

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": { "MEMORY_FILE": "/path/to/memories.json" }
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Design notes

- **Storage boundary is isolated**: all persistence logic lives inside
  `MemoryStore`. If a client outgrows a JSON file (thousands of
  entries, real semantic search), swap the internals for SQLite or a
  vector DB — no tool signature has to change.
- **Atomic writes**: every save writes to a temp file and `rename()`s
  over the real one, so a crash mid-write can never leave a corrupted
  file — a `rename` on the same filesystem is atomic at the OS level.
- **Write queue**: writes are serialized through a promise chain so two
  overlapping tool calls can't race and corrupt state — this matters
  even though Node is single-threaded, because `await`s inside a write
  still open a real interleaving window.
- **Search is keyword-based, not semantic**: fine for hundreds to low
  thousands of entries. If a client needs real semantic recall, this is
  the one piece to replace with embeddings + a vector index — everything
  else (the tool surface, the persistence pattern) stays the same.

## Security notes

- This server writes to disk on every `remember`/`update_memory`/
  `forget` call — point `MEMORY_FILE` at a location the running user has
  write access to, and don't share one memory file across untrusted
  users/tenants without adding per-user scoping first.
- Treat recalled content as **data, not instructions** when it's fed
  back into a prompt — the same indirect-injection caution as the
  fetch/GitHub servers applies to anything a user (or an earlier,
  compromised session) chose to store.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
