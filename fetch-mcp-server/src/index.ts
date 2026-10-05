#!/usr/bin/env node
/**
 * Fetch MCP Server
 * -----------------------------------------------------------------------
 * Tier 1 (Phase 1) reference server: zero auth, stdio transport, read-only.
 * Fetches a URL and returns clean, LLM-readable text (HTML -> Markdown).
 *
 * Second "body" proof point: same scaffolding pattern as
 * filesystem-mcp-server, different domain logic entirely — this is the
 * ~20-30% that never templates, on purpose.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import TurndownService from "turndown";
import { URL } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";

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
const DEFAULT_MAX_CHARS = numEnv("MAX_RESPONSE_CHARS", 20_000);
const REQUEST_TIMEOUT_MS = numEnv("REQUEST_TIMEOUT_MS", 10_000);
const USER_AGENT =
  process.env.FETCH_USER_AGENT ?? "fetch-mcp-server/1.0 (+https://modelcontextprotocol.io)";

const turndown = new TurndownService({ headingStyle: "atx" });

// ---------------------------------------------------------------------------
// Security helper: basic SSRF guard.
// Refuses to fetch localhost / link-local / private-network addresses so a
// malicious or careless prompt can't use this server to probe your
// internal network. Not exhaustive — for a production/remote deployment,
// pair this with an egress proxy allowlist.
// ---------------------------------------------------------------------------
async function assertPublicHost(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) {
    throw new Error(`Refusing to fetch local hostname "${hostname}".`);
  }

  let addresses: string[];
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    // DNS lookup failing is not itself a security issue; let the actual
    // fetch surface the real error.
    return;
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      throw new Error(
        `Refusing to fetch "${hostname}" — resolves to a private/reserved IP (${addr}).`
      );
    }
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    return false;
  }
  return false;
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "fetch-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "fetch_url",
  {
    title: "Fetch URL",
    description:
      "Fetch a web page and return its content as clean Markdown (HTML stripped of " +
      "nav/ads/scripts). Supports pagination via start_index for long pages.",
    inputSchema: {
      url: z.string().url().describe("The absolute URL to fetch (http/https only)"),
      max_length: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .default(DEFAULT_MAX_CHARS)
        .describe("Maximum characters to return"),
      start_index: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Character offset to start from, for paginating long pages"),
      raw: z
        .boolean()
        .default(false)
        .describe("Return raw HTML instead of converted Markdown"),
    },
  },
  async ({ url, max_length, start_index, raw }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return toolError(`"${url}" is not a valid URL.`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return toolError(`Unsupported protocol "${parsed.protocol}". Only http/https allowed.`);
    }

    try {
      await assertPublicHost(parsed.hostname);
    } catch (err) {
      return toolError((err as Error).message);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(parsed.toString(), {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return toolError(`Request failed: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      let text: string;
      if (raw || !contentType.includes("html")) {
        text = body;
      } else {
        text = turndown.turndown(body);
      }

      const total = text.length;
      const slice = text.slice(start_index, start_index + max_length);
      const truncated = start_index + max_length < total;

      const footer = truncated
        ? `\n\n[Truncated. ${total - (start_index + max_length)} characters remaining — ` +
          `call again with start_index=${start_index + max_length} to continue.]`
        : "";

      return { content: [{ type: "text", text: slice + footer }] };
    } catch (err) {
      clearTimeout(timeout);
      const message =
        (err as Error).name === "AbortError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms.`
          : (err as Error).message;
      return toolError(message);
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
  console.error("fetch-mcp-server running.");
}

main().catch((err) => {
  console.error("Fatal error starting fetch-mcp-server:", err);
  process.exit(1);
});
