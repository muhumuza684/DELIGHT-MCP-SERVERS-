<!-- mcp-name: io.github.yourorg/postgres-mcp-server -->
# postgres-mcp-server (read-only)

_

Tier 2 reference MCP server — **credential-in-connection-string auth**,
stdio transport, read-only Postgres access. Same auth-head *shape* as
`github-mcp-server` (one secret, one wrapper), completely different
domain logic (SQL safety instead of HTTP calls) — this pairing is the
evidence for what Phase 6 should and shouldn't template.

## Tools (all read-only)

| Tool | Description |
|---|---|
| `list_schemas` | List non-system schemas |
| `list_tables` | List tables/views in a schema |
| `describe_table` | Column names, types, nullability |
| `run_query` | Run a single `SELECT`, capped rows, capped time |

## Setup

```bash
npm install
npm run build
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string — see below |
| `STATEMENT_TIMEOUT_MS` | no | Per-query timeout (default 5000) |
| `MAX_ROWS` | no | Row cap per query result (default 200) |

**Use a dedicated read-only database role.** Don't point this at an
admin/owner connection string — the query-safety checks in this server
are defense-in-depth, not a substitute for real database permissions.

```sql
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE yourdb TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
```

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://mcp_readonly:xxx@host:5432/yourdb" }
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Security notes — read three layers, not one

1. **Database role**: use a role with `SELECT`-only grants (above). This
   is the real boundary; everything below is defense-in-depth on top of it.
2. **Transaction**: every `run_query` call runs inside
   `BEGIN TRANSACTION READ ONLY`, which Postgres itself enforces at the
   engine level.
3. **Static check**: `assertSafeSelect()` rejects anything that isn't a
   single `SELECT`/`WITH` statement, blocks semicolon-stacked statements,
   and blocks a keyword denylist (`insert`, `update`, `delete`, `drop`,
   `alter`, etc).
4. **Timeout + row cap**: `statement_timeout` bounds runaway queries;
   results are truncated at `MAX_ROWS` so a huge table scan can't flood
   the agent's context.

Don't remove any one of these thinking another covers it — they defend
against different failure modes (a role misconfiguration, a clever SQL
bypass, a hung query, a huge result set are four separate risks).

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
