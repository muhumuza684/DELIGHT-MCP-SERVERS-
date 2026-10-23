#!/usr/bin/env node
/**
 * Fetch MCP Server  (delight-fetch-patch 2026-10-08)
 * -----------------------------------------------------------------------
 * Zero auth, stdio transport, read-only. Fetches a URL and returns clean,
 * LLM-readable Markdown.
 *
 * What this version guarantees (and the tests check):
 *   - scripts, styles, menus, footers and sidebars are removed from pages
 *   - every redirect hop is re-checked, so a public link cannot bounce you
 *     to localhost or a private network address
 *   - IPv6 forms such as [::1] and ::ffff:127.0.0.1 are refused too
 *   - pages over MAX_PAGE_BYTES are refused instead of loaded into memory
 *   - images, PDFs and other binary files are refused with a clear message
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import TurndownService from "turndown";
import { URL } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";

// <helpers>
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
const MAX_PAGE_BYTES = numEnv("MAX_PAGE_BYTES", 5_000_000);
const MAX_REDIRECTS = 5;
const USER_AGENT =
  process.env.FETCH_USER_AGENT ?? "fetch-mcp-server/1.0 (+https://modelcontextprotocol.io)";

// Blocks localhost, private networks and link-local addresses so a careless
// or malicious prompt cannot use this server to probe your own network.
async function assertPublicHost(rawHost: string): Promise<void> {
  const hostname = rawHost.replace(/^\[|\]$/g, ""); // URL gives IPv6 hosts in [brackets]
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    throw new Error(`Refusing to fetch local hostname "${rawHost}".`);
  }
  let addresses: string[];
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    // A failed lookup is not a security problem; the real request will fail on its own.
    return;
  }
  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      throw new Error(`Refusing to fetch "${rawHost}" — resolves to a private/reserved IP (${addr}).`);
    }
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    const mapped = /^(?:0:0:0:0:0:ffff:|::ffff:)(.+)$/.exec(lower); // IPv4 hidden inside IPv6
    if (mapped) {
      const rest = mapped[1];
      if (rest.includes(".")) return isPrivateOrReservedIp(rest);
      const parts = rest.split(":");
      if (parts.length === 2) {
        const h1 = parseInt(parts[0], 16);
        const h2 = parseInt(parts[1], 16);
        return isPrivateOrReservedIp(`${h1 >> 8}.${h1 & 255}.${h2 >> 8}.${h2 & 255}`);
      }
    }
    return false;
  }
  return false;
}

function isBinaryType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return /^(image|audio|video|font)\//.test(t) || t.includes("application/pdf") ||
    t.includes("application/octet-stream") || t.includes("zip");
}

// Reads the response body but gives up once it passes maxBytes.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`This page is larger than ${maxBytes} bytes, so it was not loaded.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Follows redirects by hand so EVERY hop passes the same checks as the first.
async function safeFetch(startUrl: URL, signal: AbortSignal): Promise<{ res: Response; finalUrl: URL }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Unsupported protocol "${current.protocol}". Only http/https allowed.`);
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current.toString(), {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      try { await res.body?.cancel(); } catch { /* nothing to clean up */ }
      current = new URL(location, current);
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

// Keeps the readable part of a page: takes the <body>, drops scripts, styles,
// menus, footers and sidebars, and pulls the <title> out separately.
function cleanHtml(html: string): { title: string; body: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|object|embed)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
  return { title, body };
}
// </helpers>

const turndown = new TurndownService({ headingStyle: "atx" });
turndown.remove(["script", "style", "noscript"]);

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "fetch-mcp-server", version: "1.0.0" });

server.registerTool(
  "fetch_url",
  {
    title: "Fetch URL",
    description:
      "Fetch a web page and return its main content as Markdown. Scripts, styles, menus, footers and " +
      "sidebars are removed. Long pages come in chunks: use start_index to continue. Pages that only " +
      "build themselves with JavaScript may come back nearly empty.",
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
        .describe("Return the page's raw source instead of cleaned Markdown"),
    },
  },
  async ({ url, max_length, start_index, raw }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return toolError(`"${url}" is not a valid URL.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const { res, finalUrl } = await safeFetch(parsed, controller.signal);

      if (!res.ok) {
        clearTimeout(timeout);
        return toolError(`Request failed: HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (isBinaryType(contentType)) {
        clearTimeout(timeout);
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return toolError(`This is a ${contentType.split(";")[0]} file, not a web page, so it cannot be read as text.`);
      }

      const body = await readCapped(res, MAX_PAGE_BYTES);
      clearTimeout(timeout);

      let text: string;
      if (raw || !contentType.includes("html")) {
        text = body;
      } else {
        const { title, body: inner } = cleanHtml(body);
        const markdown = turndown.turndown(inner).trim();
        text = (title ? `Title: ${title}\n` : "") + `URL: ${finalUrl.toString()}\n\n` + markdown;
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("fetch-mcp-server running.");
  console.error("Built in Uganda by Bryt Matech UG");
}

main().catch((err) => {
  console.error("Fatal error starting fetch-mcp-server:", err);
  process.exit(1);
});
