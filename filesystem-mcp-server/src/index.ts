#!/usr/bin/env node
/**
 * Filesystem MCP Server
 * -----------------------------------------------------------------------
 * Tier 1 (Phase 1) reference server: zero external auth, stdio transport,
 * read + scoped write access to ONE root directory on disk.
 *
 * This is the "body" template for every future stdio server you build:
 *   - env/config loading
 *   - tool schema definitions with zod
 *   - consistent error handling / MCP-shaped errors
 *   - a security boundary (never let the agent escape ALLOWED_DIR)
 *
 * Copy this folder as your starting point for any new stdio server.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";

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
const ALLOWED_DIR = process.env.ALLOWED_DIR
  ? path.resolve(process.env.ALLOWED_DIR)
  : path.resolve(process.cwd());

const MAX_FILE_BYTES = numEnv("MAX_FILE_BYTES", 1_000_000); // 1 MB default

// ---------------------------------------------------------------------------
// Security helper: resolve a user-supplied relative path and refuse to
// leave ALLOWED_DIR under any circumstances (no "../../etc/passwd" tricks).
// ---------------------------------------------------------------------------
function resolveSafePath(relativePath: string): string {
  const resolved = path.resolve(ALLOWED_DIR, relativePath);
  if (resolved !== ALLOWED_DIR && !resolved.startsWith(ALLOWED_DIR + path.sep)) {
    throw new Error(
      `Path "${relativePath}" resolves outside the allowed directory. Refusing.`
    );
  }
  return resolved;
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
const server = new McpServer({ name: "filesystem-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "list_directory",
  {
    title: "List directory",
    description:
      "List files and subdirectories inside the allowed root directory. " +
      "Path is relative to the server's configured root; use '.' for the root itself.",
    inputSchema: {
      path: z.string().default(".").describe("Relative path inside the allowed directory"),
    },
  },
  async ({ path: relPath }) => {
    try {
      const target = resolveSafePath(relPath);
      const entries = await fs.readdir(target, { withFileTypes: true });
      const listing = entries
        .map((e) => `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`)
        .sort()
        .join("\n");
      return {
        content: [
          { type: "text", text: listing || "(empty directory)" },
        ],
      };
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description:
      `Read a UTF-8 text file's contents. Refuses files larger than ${MAX_FILE_BYTES} bytes.`,
    inputSchema: {
      path: z.string().describe("Relative path of the file to read"),
    },
  },
  async ({ path: relPath }) => {
    try {
      const target = resolveSafePath(relPath);
      const stat = await fs.stat(target);
      if (!stat.isFile()) return toolError(`"${relPath}" is not a file.`);
      if (stat.size > MAX_FILE_BYTES) {
        return toolError(
          `File is ${stat.size} bytes, which exceeds the ${MAX_FILE_BYTES}-byte limit.`
        );
      }
      const content = await fs.readFile(target, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "write_file",
  {
    title: "Write file",
    description:
      "Create or overwrite a UTF-8 text file inside the allowed directory. " +
      "This is a WRITE/side-effect tool — the client should confirm with the user before invoking it.",
    inputSchema: {
      path: z.string().describe("Relative path of the file to write"),
      content: z.string().describe("Full text content to write"),
    },
  },
  async ({ path: relPath, content }) => {
    try {
      const target = resolveSafePath(relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
      return {
        content: [{ type: "text", text: `Wrote ${content.length} characters to ${relPath}` }],
      };
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "create_directory",
  {
    title: "Create directory",
    description: "Create a directory (and parents) inside the allowed directory.",
    inputSchema: {
      path: z.string().describe("Relative path of the directory to create"),
    },
  },
  async ({ path: relPath }) => {
    try {
      const target = resolveSafePath(relPath);
      await fs.mkdir(target, { recursive: true });
      return { content: [{ type: "text", text: `Created directory ${relPath}` }] };
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "delete_file",
  {
    title: "Delete file",
    description:
      "Delete a single file inside the allowed directory. " +
      "This is a DESTRUCTIVE tool — the client should confirm with the user before invoking it. " +
      "Refuses to delete directories.",
    inputSchema: {
      path: z.string().describe("Relative path of the file to delete"),
    },
  },
  async ({ path: relPath }) => {
    try {
      const target = resolveSafePath(relPath);
      const stat = await fs.stat(target);
      if (!stat.isFile()) return toolError(`"${relPath}" is not a file; refusing to delete.`);
      await fs.unlink(target);
      return { content: [{ type: "text", text: `Deleted ${relPath}` }] };
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
  console.error(`filesystem-mcp-server running. Root: ${ALLOWED_DIR}`);
}

main().catch((err) => {
  console.error("Fatal error starting filesystem-mcp-server:", err);
  process.exit(1);
});
