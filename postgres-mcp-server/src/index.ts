#!/usr/bin/env node
/**
 * Postgres MCP Server (read-only)
 * -----------------------------------------------------------------------
 * Tier 2 (Phase 2) reference server: API-key-style auth (a connection
 * string/credentials, not OAuth), stdio transport, read-only.
 *
 * Second proof point for the "API-key auth head" — same shape as
 * github-mcp-server (one secret in env, one wrapper every tool goes
 * through), but the domain logic (SQL, schema introspection, query
 * safety) is entirely different. This is expected — see the Phase 2
 * README for what actually turned out to be shared vs not.
 *
 * Read-only is enforced at THREE layers, not one:
 *   1. Every session opens a READ ONLY transaction
 *   2. The query is statically checked to be a single SELECT statement
 *   3. A statement_timeout bounds how long a query may run
 * Do not remove any of the three "just because" — they defend against
 * different failure modes (a bypass of #2, a hung query, etc).
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`Warning: ${name}="${raw}" is not a valid number; using default ${fallback}.`);
    return fallback;
  }
  return n;
}
const DATABASE_URL = process.env.DATABASE_URL;
const STATEMENT_TIMEOUT_MS = (() => {
  // Extra positivity check on top of numEnv() because this value gets
  // string-interpolated into `SET LOCAL` below — it can't be parameterized
  // the normal way, so zero/negative needs to be rejected outright rather
  // than just falling back silently.
  const n = numEnv("STATEMENT_TIMEOUT_MS", 5000);
  if (n <= 0) {
    throw new Error(`STATEMENT_TIMEOUT_MS must be a positive number, got "${process.env.STATEMENT_TIMEOUT_MS}"`);
  }
  return Math.floor(n);
})();
const MAX_ROWS = numEnv("MAX_ROWS", 200);

if (!DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. Use a read-only database role, e.g.\n" +
      "  postgres://readonly_user:password@host:5432/dbname"
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

// ---------------------------------------------------------------------------
// Query-safety helper: only a single, non-mutating SELECT is allowed.
// This is defense-in-depth ON TOP OF the READ ONLY transaction below,
// not a substitute for it.
// ---------------------------------------------------------------------------
const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex)\b/i;

function assertSafeSelect(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, ""); // allow one trailing semicolon
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed. Submit exactly one SELECT.");
  }
  if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) {
    throw new Error("Only SELECT (or SELECT-based WITH/CTE) statements are allowed.");
  }
  if (FORBIDDEN_KEYWORDS.test(trimmed)) {
    throw new Error("Query contains a disallowed keyword for a read-only server.");
  }
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "postgres-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "list_schemas",
  {
    title: "List schemas",
    description: "List non-system schemas in the database.",
    inputSchema: {},
  },
  async () => {
    try {
      const { rows } = await pool.query(
        `select schema_name from information_schema.schemata
         where schema_name not in ('pg_catalog','information_schema')
         order by schema_name`
      );
      return textResult(rows.map((r) => r.schema_name));
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_tables",
  {
    title: "List tables",
    description: "List tables (and views) in a given schema.",
    inputSchema: {
      schema: z.string().default("public"),
    },
  },
  async ({ schema }) => {
    try {
      const { rows } = await pool.query(
        `select table_name, table_type from information_schema.tables
         where table_schema = $1 order by table_name`,
        [schema]
      );
      return textResult(rows);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "describe_table",
  {
    title: "Describe table",
    description: "List column names, types, and nullability for a table.",
    inputSchema: {
      schema: z.string().default("public"),
      table: z.string(),
    },
  },
  async ({ schema, table }) => {
    try {
      const { rows } = await pool.query(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = $1 and table_name = $2
         order by ordinal_position`,
        [schema, table]
      );
      if (rows.length === 0) {
        return toolError(`No columns found for "${schema}.${table}" — does it exist?`);
      }
      return textResult(rows);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "run_query",
  {
    title: "Run read-only query",
    description:
      `Run a single SELECT query. Runs inside a READ ONLY transaction with a ` +
      `${STATEMENT_TIMEOUT_MS}ms timeout, results capped at ${MAX_ROWS} rows.`,
    inputSchema: {
      sql: z.string().describe("A single SELECT statement"),
    },
  },
  async ({ sql }) => {
    try {
      assertSafeSelect(sql);
    } catch (err) {
      return toolError((err as Error).message);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const result = await client.query(sql);
      await client.query("COMMIT");

      const truncated = result.rows.length > MAX_ROWS;
      const rows = result.rows.slice(0, MAX_ROWS);
      return textResult({
        row_count: result.rows.length,
        returned: rows.length,
        truncated,
        rows,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return toolError((err as Error).message);
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Built in Uganda ???? by Bryt Matech UG");
  console.error("postgres-mcp-server running in READ-ONLY mode.");
}

main().catch((err) => {
  console.error("Fatal error starting postgres-mcp-server:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
