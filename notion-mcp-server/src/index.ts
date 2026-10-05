#!/usr/bin/env node
/**
 * Notion MCP Server
 * -----------------------------------------------------------------------
 * Tier 4 (Phase 4) reference server #3 — OAuth 2.1, stdio transport,
 * read-only.
 *
 * Notion-specific OAuth notes — this is the one that genuinely broke the
 * "generic OAuth2" assumptions in oauth.ts, which is exactly why that
 * module now has a `tokenAuthStyle` option:
 *   - Notion's token endpoint wants a Basic auth header
 *     (base64 client_id:client_secret) + a JSON body, NOT
 *     application/x-www-form-urlencoded — see tokenAuthStyle: "basic_json"
 *   - Notion's public OAuth integrations generally do not issue refresh
 *     tokens or expire access tokens the way Google/Slack do — the token
 *     is effectively long-lived until the user revokes access
 *   - Notion requires a specific API version header on every API call
 *     (Notion-Version), unrelated to OAuth but easy to forget
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TokenManager } from "./oauth.js";

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
const CLIENT_ID = process.env.NOTION_CLIENT_ID;
const CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const REDIRECT_PORT = numEnv("OAUTH_REDIRECT_PORT", 8736);
const TOKEN_FILE = process.env.TOKEN_FILE ?? "./.notion-tokens.json";
const NOTION_VERSION = "2026-03-11"; // current as of this build; check developers.notion.com/reference/versioning for newer

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "FATAL: NOTION_CLIENT_ID and NOTION_CLIENT_SECRET must be set. " +
      "Create a public integration at notion.so/my-integrations."
  );
  process.exit(1);
}

const tokenManager = new TokenManager({
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: [], // Notion's public OAuth doesn't use scope negotiation this way — access is capability-based per the integration's configured capabilities
  redirectPort: REDIRECT_PORT,
  tokenFile: TOKEN_FILE,
  usesPkce: false,
  tokenAuthStyle: "basic_json",
  extraAuthParams: { owner: "user" },
});

async function notionApi(path: string, opts: RequestInit = {}) {
  const token = await tokenManager.getAccessToken();
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opts,
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Flattens Notion's verbose rich_text block structure into plain strings —
// otherwise every tool response is dominated by formatting metadata the
// agent doesn't need.
function extractPlainText(richText: any[]): string {
  return (richText ?? []).map((t: any) => t.plain_text ?? "").join("");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "notion-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "search",
  {
    title: "Search",
    description: "Search pages and databases the integration has been given access to.",
    inputSchema: {
      query: z.string().describe("Search text"),
      filter_type: z.enum(["page", "database", "any"]).default("any"),
      limit: z.number().int().positive().max(100).default(20),
    },
  },
  async ({ query, filter_type, limit }) => {
    try {
      const body: any = { query, page_size: limit };
      if (filter_type !== "any") body.filter = { property: "object", value: filter_type };
      const data: any = await notionApi("search", { method: "POST", body: JSON.stringify(body) });
      const results = (data.results ?? []).map((r: any) => ({
        id: r.id,
        object: r.object,
        title:
          r.object === "page"
            ? extractPlainText(
                r.properties?.title?.title ?? r.properties?.Name?.title ?? []
              )
            : extractPlainText(r.title ?? []),
        url: r.url,
      }));
      return textResult(results);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_page",
  {
    title: "Get page",
    description: "Get a page's properties by ID.",
    inputSchema: { page_id: z.string() },
  },
  async ({ page_id }) => {
    try {
      const data: any = await notionApi(`pages/${page_id}`);
      return textResult(data);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_page_content",
  {
    title: "Get page content",
    description: "Get a page's body content as flattened plain-text blocks, in order.",
    inputSchema: { page_id: z.string() },
  },
  async ({ page_id }) => {
    try {
      const data: any = await notionApi(`blocks/${page_id}/children?page_size=100`);
      const blocks = (data.results ?? []).map((b: any) => {
        const richText = b[b.type]?.rich_text;
        return { type: b.type, text: richText ? extractPlainText(richText) : undefined };
      });
      return textResult(blocks);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "query_database",
  {
    title: "Query database",
    description: "Query a Notion database's rows (Notion's native filter/sort object, optional).",
    inputSchema: {
      database_id: z.string(),
      limit: z.number().int().positive().max(100).default(20),
    },
  },
  async ({ database_id, limit }) => {
    try {
      const data: any = await notionApi(`databases/${database_id}/query`, {
        method: "POST",
        body: JSON.stringify({ page_size: limit }),
      });
      return textResult(data.results ?? []);
    } catch (err) {
      return toolError((err as Error).message);
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
  console.error("notion-mcp-server running in READ-ONLY mode.");
}

main().catch((err) => {
  console.error("Fatal error starting notion-mcp-server:", err);
  process.exit(1);
});
