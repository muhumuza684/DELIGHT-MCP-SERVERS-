#!/usr/bin/env node
/**
 * Google Drive MCP Server
 * -----------------------------------------------------------------------
 * Tier 4 (Phase 4) reference server #2 — OAuth 2.1, stdio transport,
 * read-only (kept read-only deliberately; Drive writes — create/delete/
 * move files — are a natural Tier 5 extension once this pattern is proven).
 *
 * Google-specific OAuth notes (compare against Slack's oauth.ts usage):
 *   - PKCE IS used (usesPkce defaults to true)
 *   - Refresh tokens are only returned on the FIRST consent unless you
 *     force re-consent — access_type=offline + prompt=consent are set
 *     in extraAuthParams below specifically to guarantee one is issued
 *   - Google Docs/Sheets/Slides are virtual files with no direct binary
 *     content — they must be *exported* via a separate endpoint/mimeType,
 *     unlike a normal uploaded file which is downloaded via alt=media
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
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_PORT = numEnv("OAUTH_REDIRECT_PORT", 8735);
const TOKEN_FILE = process.env.TOKEN_FILE ?? "./.google-tokens.json";
const MAX_EXPORT_CHARS = numEnv("MAX_EXPORT_CHARS", 50_000);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "FATAL: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. " +
      "Create OAuth credentials in Google Cloud Console (APIs & Services > Credentials)."
  );
  process.exit(1);
}

const tokenManager = new TokenManager({
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  redirectPort: REDIRECT_PORT,
  tokenFile: TOKEN_FILE,
  usesPkce: true,
  extraAuthParams: {
    access_type: "offline", // required to get a refresh_token at all
    prompt: "consent", // forces the consent screen so a refresh_token is re-issued
  },
});

async function driveApi(pathAndQuery: string, opts: RequestInit = {}) {
  const token = await tokenManager.getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${pathAndQuery}`, {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const GOOGLE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "google-drive-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "search_files",
  {
    title: "Search files",
    description: "Search Drive files by name (and optionally full text).",
    inputSchema: {
      query: z.string().describe("Text to search for in file names/content"),
      limit: z.number().int().positive().max(100).default(20),
    },
  },
  async ({ query, limit }) => {
    try {
      const q = encodeURIComponent(
        `(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}') and trashed = false`
      );
      const res = await driveApi(
        `files?q=${q}&pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime,owners)`
      );
      const data: any = await res.json();
      return textResult(data.files ?? []);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_files",
  {
    title: "List files",
    description: "List files, optionally within a specific folder ID.",
    inputSchema: {
      folder_id: z.string().optional(),
      limit: z.number().int().positive().max(100).default(20),
    },
  },
  async ({ folder_id, limit }) => {
    try {
      const q = folder_id
        ? encodeURIComponent(`'${folder_id}' in parents and trashed = false`)
        : encodeURIComponent("trashed = false");
      const res = await driveApi(
        `files?q=${q}&pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime)`
      );
      const data: any = await res.json();
      return textResult(data.files ?? []);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_file_metadata",
  {
    title: "Get file metadata",
    description: "Get metadata for a single file by ID.",
    inputSchema: { file_id: z.string() },
  },
  async ({ file_id }) => {
    try {
      const res = await driveApi(
        `files/${file_id}?fields=id,name,mimeType,modifiedTime,owners,size,webViewLink`
      );
      return textResult(await res.json());
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "read_file_content",
  {
    title: "Read file content",
    description:
      "Read a file's text content. Google Docs/Sheets/Slides are exported as text/CSV; " +
      "other file types are downloaded directly (text-based types only).",
    inputSchema: { file_id: z.string() },
  },
  async ({ file_id }) => {
    try {
      const metaRes = await driveApi(`files/${file_id}?fields=mimeType,name`);
      const meta: any = await metaRes.json();
      const exportMime = GOOGLE_EXPORT_MIME[meta.mimeType];

      const contentRes = exportMime
        ? await driveApi(`files/${file_id}/export?mimeType=${encodeURIComponent(exportMime)}`)
        : await driveApi(`files/${file_id}?alt=media`);

      const text = await contentRes.text();
      const truncated = text.length > MAX_EXPORT_CHARS;
      return textResult({
        name: meta.name,
        mime_type: meta.mimeType,
        truncated,
        content: text.slice(0, MAX_EXPORT_CHARS),
      });
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
  console.error("google-drive-mcp-server running in READ-ONLY mode.");
}

main().catch((err) => {
  console.error("Fatal error starting google-drive-mcp-server:", err);
  process.exit(1);
});
