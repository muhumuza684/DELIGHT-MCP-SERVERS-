#!/usr/bin/env node
/**
 * Memory MCP Server
 * -----------------------------------------------------------------------
 * Tier 3 (Phase 3) reference server: no external auth, stdio transport,
 * STATEFUL — this is the first server where persistence design matters,
 * not just pass-through logic.
 *
 * Storage model: a flat list of memory entries (content + tags + a
 * timestamp), persisted as a single JSON file on disk. Simple on purpose
 * — the goal of this tier is to prove out the read-modify-persist
 * pattern correctly (atomic writes, no corruption on crash) before
 * Tier 4/5 servers layer OAuth and side effects on top of state.
 *
 * If a client's needs outgrow this (thousands of entries, real semantic
 * search), swap MemoryStore's internals for SQLite or a vector DB
 * without changing a single tool signature — that boundary is exactly
 * why the store is its own class.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
const MEMORY_FILE = path.resolve(process.env.MEMORY_FILE ?? "./memory.json");
const MAX_ENTRIES = numEnv("MAX_ENTRIES", 5000);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

class MemoryStore {
  private entries: MemoryEntry[] = [];
  private loaded = false;
  // Serializes writes so two overlapping tool calls can't race each other
  // and corrupt the file — Node is single-threaded, but await points in
  // file I/O still create a real interleaving window without this.
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(MEMORY_FILE, "utf-8");
      this.entries = JSON.parse(raw);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      this.entries = []; // first run — no file yet
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    // Atomic write: write to a temp file, then rename over the real one,
    // so a crash mid-write can never leave a half-written / corrupt file.
    const tmpFile = `${MEMORY_FILE}.tmp-${process.pid}`;
    await fs.writeFile(tmpFile, JSON.stringify(this.entries, null, 2), "utf-8");
    await fs.rename(tmpFile, MEMORY_FILE);
  }

  private enqueueWrite(mutate: () => void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      mutate();
      await this.persist();
    });
    return this.writeQueue;
  }

  async remember(content: string, tags: string[]): Promise<MemoryEntry> {
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(`Memory store is full (${MAX_ENTRIES} entries). Forget some first.`);
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      content,
      tags,
      created_at: now,
      updated_at: now,
    };
    await this.enqueueWrite(() => this.entries.push(entry));
    return entry;
  }

  async update(id: string, content?: string, tags?: string[]): Promise<MemoryEntry> {
    const existing = this.entries.find((e) => e.id === id);
    if (!existing) throw new Error(`No memory found with id "${id}".`);
    await this.enqueueWrite(() => {
      if (content !== undefined) existing.content = content;
      if (tags !== undefined) existing.tags = tags;
      existing.updated_at = new Date().toISOString();
    });
    return existing;
  }

  async forget(id: string): Promise<boolean> {
    const existed = this.entries.some((e) => e.id === id);
    if (existed) {
      await this.enqueueWrite(() => {
        this.entries = this.entries.filter((e) => e.id !== id);
      });
    }
    return existed;
  }

  // Simple keyword relevance: counts case-insensitive term hits across
  // content + tags. Good enough for hundreds/low-thousands of entries;
  // swap for embeddings if a client needs real semantic recall.
  search(query: string, limit: number): MemoryEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.entries.slice(0, limit);

    const scored = this.entries
      .map((entry) => {
        const haystack = `${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
          0
        );
        return { entry, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (b.entry.updated_at > a.entry.updated_at ? 1 : -1));

    return scored.slice(0, limit).map((s) => s.entry);
  }

  list(tag: string | undefined, limit: number): MemoryEntry[] {
    const filtered = tag ? this.entries.filter((e) => e.tags.includes(tag)) : this.entries;
    return [...filtered]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, limit);
  }

  count(): number {
    return this.entries.length;
  }
}

const store = new MemoryStore();

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
const server = new McpServer({ name: "memory-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "remember",
  {
    title: "Remember",
    description:
      "Store a new fact/memory for later recall. Keep content short and self-contained " +
      "(one fact per call reads back better than a paragraph of mixed facts).",
    inputSchema: {
      content: z.string().min(1).describe("The fact to remember"),
      tags: z.array(z.string()).default([]).describe("Optional tags for later filtering"),
    },
  },
  async ({ content, tags }) => {
    try {
      await store.load();
      const entry = await store.remember(content, tags);
      return textResult({ stored: entry });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "recall",
  {
    title: "Recall",
    description: "Search stored memories by keyword relevance.",
    inputSchema: {
      query: z.string().min(1).describe("Keywords to search for"),
      limit: z.number().int().positive().max(100).default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      await store.load();
      const results = store.search(query, limit);
      return textResult({ count: results.length, results });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_memories",
  {
    title: "List memories",
    description: "List stored memories, most recently updated first, optionally filtered by tag.",
    inputSchema: {
      tag: z.string().optional(),
      limit: z.number().int().positive().max(500).default(50),
    },
  },
  async ({ tag, limit }) => {
    try {
      await store.load();
      const results = store.list(tag, limit);
      return textResult({ total_stored: store.count(), returned: results.length, results });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "update_memory",
  {
    title: "Update memory",
    description: "Update the content and/or tags of an existing memory by id.",
    inputSchema: {
      id: z.string().uuid(),
      content: z.string().min(1).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ id, content, tags }) => {
    try {
      await store.load();
      const entry = await store.update(id, content, tags);
      return textResult({ updated: entry });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "forget",
  {
    title: "Forget",
    description: "Permanently delete a memory by id. This is a DESTRUCTIVE tool.",
    inputSchema: {
      id: z.string().uuid(),
    },
  },
  async ({ id }) => {
    try {
      await store.load();
      const existed = await store.forget(id);
      if (!existed) return toolError(`No memory found with id "${id}".`);
      return textResult({ deleted: id });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await store.load();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Built in Uganda ???? by Bryt Matech UG");
  console.error(`memory-mcp-server running. Store: ${MEMORY_FILE} (${store.count()} entries)`);
}

main().catch((err) => {
  console.error("Fatal error starting memory-mcp-server:", err);
  process.exit(1);
});
