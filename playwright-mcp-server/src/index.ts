#!/usr/bin/env node
/**
 * Playwright MCP Server
 * -----------------------------------------------------------------------
 * Tier 5 (Phase 5) reference server #1 — no external account auth, stdio
 * transport, real side effects (drives an actual browser: clicks, form
 * fills). This tier is harder than the API-wrapper tiers not because of
 * auth, but because of STATE + TIMING: pages load asynchronously, DOM
 * selectors can be stale, and a hung page can hang the whole server
 * without hard timeouts everywhere.
 *
 * Session model: one Chromium instance for the server's lifetime,
 * multiple named "pages" (tabs) keyed by page_id so an agent can work
 * across more than one page without them clobbering each other.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

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
const NAV_TIMEOUT_MS = numEnv("NAV_TIMEOUT_MS", 15_000);
const ACTION_TIMEOUT_MS = numEnv("ACTION_TIMEOUT_MS", 10_000);
const MAX_PAGES = numEnv("MAX_PAGES", 5);
const MAX_TEXT_CHARS = numEnv("MAX_TEXT_CHARS", 20_000);
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";

// ---------------------------------------------------------------------------
// Security helper — same SSRF guard pattern as fetch-mcp-server. Copied,
// not imported, on purpose: this server has no dependency on that one,
// and the check is small enough that duplicating it beats coupling two
// otherwise-unrelated servers together.
// ---------------------------------------------------------------------------
async function assertPublicHost(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) {
    throw new Error(`Refusing to navigate to local hostname "${hostname}".`);
  }
  let addresses: string[];
  try {
    addresses = (await dns.lookup(hostname, { all: true })).map((r) => r.address);
  } catch {
    return;
  }
  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      throw new Error(`Refusing to navigate to "${hostname}" — resolves to private IP ${addr}.`);
    }
  }
}
function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd");
  }
  return false;
}

// ---------------------------------------------------------------------------
// Browser/page session management
// ---------------------------------------------------------------------------
let browser: Browser | null = null;
const pages = new Map<string, Page>();

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: HEADLESS });
  }
  return browser;
}

async function getOrCreatePage(pageId: string): Promise<Page> {
  const existing = pages.get(pageId);
  if (existing && !existing.isClosed()) return existing;

  if (pages.size >= MAX_PAGES) {
    throw new Error(`Maximum of ${MAX_PAGES} open pages reached. Close one first with close_page.`);
  }
  const b = await getBrowser();
  const context = await b.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  pages.set(pageId, page);
  return page;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "playwright-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "navigate",
  {
    title: "Navigate",
    description: "Open a URL in a (named) browser page/tab. Creates the page if it doesn't exist.",
    inputSchema: {
      url: z.string().url(),
      page_id: z.string().default("default"),
    },
  },
  async ({ url, page_id }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return toolError(`Unsupported protocol "${parsed.protocol}". Only http/https allowed.`);
      }
      await assertPublicHost(parsed.hostname);

      const page = await getOrCreatePage(page_id);
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      return textResult(
        `Navigated to ${page.url()}\nTitle: ${await page.title()}\nStatus: ${response?.status() ?? "unknown"}`
      );
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_page_text",
  {
    title: "Get page text",
    description: "Get the visible text content of the page, or of a specific CSS selector.",
    inputSchema: {
      page_id: z.string().default("default"),
      selector: z.string().optional().describe("CSS selector; omit for the whole page"),
    },
  },
  async ({ page_id, selector }) => {
    try {
      const page = pages.get(page_id);
      if (!page) return toolError(`No open page with id "${page_id}". Call navigate first.`);
      const locator = selector ? page.locator(selector).first() : page.locator("body");
      const text = await locator.innerText();
      const truncated = text.length > MAX_TEXT_CHARS;
      return textResult(text.slice(0, MAX_TEXT_CHARS) + (truncated ? "\n[...truncated]" : ""));
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "click",
  {
    title: "Click",
    description: "Click an element matched by a CSS selector.",
    inputSchema: {
      page_id: z.string().default("default"),
      selector: z.string(),
    },
  },
  async ({ page_id, selector }) => {
    try {
      const page = pages.get(page_id);
      if (!page) return toolError(`No open page with id "${page_id}". Call navigate first.`);
      await page.locator(selector).first().click();
      return textResult(`Clicked "${selector}".`);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "fill",
  {
    title: "Fill",
    description: "Type text into an input/textarea matched by a CSS selector (clears it first).",
    inputSchema: {
      page_id: z.string().default("default"),
      selector: z.string(),
      value: z.string(),
    },
  },
  async ({ page_id, selector, value }) => {
    try {
      const page = pages.get(page_id);
      if (!page) return toolError(`No open page with id "${page_id}". Call navigate first.`);
      await page.locator(selector).first().fill(value);
      return textResult(`Filled "${selector}".`);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description: "Take a screenshot of the current page (PNG).",
    inputSchema: {
      page_id: z.string().default("default"),
      full_page: z.boolean().default(false),
    },
  },
  async ({ page_id, full_page }) => {
    try {
      const page = pages.get(page_id);
      if (!page) return toolError(`No open page with id "${page_id}". Call navigate first.`);
      const buffer = await page.screenshot({ fullPage: full_page, type: "png" });
      return {
        content: [
          { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_pages",
  {
    title: "List pages",
    description: "List currently open page IDs and their URLs.",
    inputSchema: {},
  },
  async () => {
    const list = [...pages.entries()]
      .filter(([, p]) => !p.isClosed())
      .map(([id, p]) => `${id}: ${p.url()}`);
    return textResult(list.join("\n") || "(no open pages)");
  }
);

server.registerTool(
  "close_page",
  {
    title: "Close page",
    description: "Close a specific page/tab and free its resources.",
    inputSchema: { page_id: z.string() },
  },
  async ({ page_id }) => {
    const page = pages.get(page_id);
    if (!page) return toolError(`No open page with id "${page_id}".`);
    await page.context().close();
    pages.delete(page_id);
    return textResult(`Closed page "${page_id}".`);
  }
);

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Built in Uganda ???? by Bryt Matech UG");
  console.error(`playwright-mcp-server running. headless=${HEADLESS}, max_pages=${MAX_PAGES}`);
}

async function shutdown() {
  for (const page of pages.values()) await page.context().close().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal error starting playwright-mcp-server:", err);
  process.exit(1);
});
