#!/usr/bin/env node
/**
 * Slack MCP Server
 * -----------------------------------------------------------------------
 * Tier 4 (Phase 4) reference server #1 — OAuth 2.1, stdio transport,
 * write-capable (posting messages is a real side effect).
 *
 * Slack-specific OAuth notes (read before assuming this is identical to
 * the Google/Notion servers in this phase):
 *   - Slack's OAuth v2 flow does not require PKCE (usesPkce: false below)
 *   - Refresh tokens are only issued if the Slack app has "token
 *     rotation" enabled in its app config — without it, the bot token
 *     simply doesn't expire, so getAccessToken() never needs to refresh
 *   - Token exchange responds with `{ ok: false, error: "..." }` on
 *     failure instead of a non-2xx HTTP status in some cases — handled
 *     explicitly in apiCall() below
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
const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_PORT = numEnv("OAUTH_REDIRECT_PORT", 8734);
const TOKEN_FILE = process.env.TOKEN_FILE ?? "./.slack-tokens.json";
const ALLOW_WRITE = (process.env.ALLOW_WRITE ?? "false").toLowerCase() === "true";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "FATAL: SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set. " +
      "Create a Slack app at api.slack.com/apps and use its Client ID/Secret."
  );
  process.exit(1);
}

const tokenManager = new TokenManager({
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: [
    "channels:read",
    "channels:history",
    "chat:write",
    "users:read",
  ],
  redirectPort: REDIRECT_PORT,
  tokenFile: TOKEN_FILE,
  usesPkce: false, // Slack's OAuth v2 flow does not require/support PKCE
});

async function apiCall(method: string, params: Record<string, unknown> = {}) {
  const token = await tokenManager.getAccessToken();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });
  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error on ${method}: ${data.error ?? "unknown error"}`);
  }
  return data;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "slack-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "list_channels",
  {
    title: "List channels",
    description: "List public channels the connected Slack app can see.",
    inputSchema: { limit: z.number().int().positive().max(200).default(50) },
  },
  async ({ limit }) => {
    try {
      const data = await apiCall("conversations.list", {
        limit,
        types: "public_channel",
      });
      const channels = (data.channels ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        is_member: c.is_member,
        topic: c.topic?.value,
      }));
      return textResult(channels);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_channel_history",
  {
    title: "Get channel history",
    description: "Fetch recent messages from a channel by its ID.",
    inputSchema: {
      channel_id: z.string(),
      limit: z.number().int().positive().max(200).default(20),
    },
  },
  async ({ channel_id, limit }) => {
    try {
      const data = await apiCall("conversations.history", { channel: channel_id, limit });
      const messages = (data.messages ?? []).map((m: any) => ({
        user: m.user,
        text: m.text,
        ts: m.ts,
      }));
      return textResult(messages);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_user_info",
  {
    title: "Get user info",
    description: "Look up a Slack user's profile by user ID.",
    inputSchema: { user_id: z.string() },
  },
  async ({ user_id }) => {
    try {
      const data = await apiCall("users.info", { user: user_id });
      return textResult({
        id: data.user.id,
        name: data.user.name,
        real_name: data.user.real_name,
        title: data.user.profile?.title,
      });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "post_message",
  {
    title: "Post message",
    description:
      "Post a message to a channel. WRITE / side-effecting — disabled unless " +
      "ALLOW_WRITE=true is set, so a server can be deployed read-only by default.",
    inputSchema: {
      channel_id: z.string(),
      text: z.string().min(1),
    },
  },
  async ({ channel_id, text }) => {
    if (!ALLOW_WRITE) {
      return toolError(
        "Write access is disabled on this server (ALLOW_WRITE is not 'true'). " +
          "This is a deliberate default — enable it explicitly to allow posting."
      );
    }
    try {
      const data = await apiCall("chat.postMessage", { channel: channel_id, text });
      return textResult({ posted: true, ts: data.ts, channel: data.channel });
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
  console.error(`slack-mcp-server running. Write access: ${ALLOW_WRITE ? "ENABLED" : "disabled"}.`);
}

main().catch((err) => {
  console.error("Fatal error starting slack-mcp-server:", err);
  process.exit(1);
});
