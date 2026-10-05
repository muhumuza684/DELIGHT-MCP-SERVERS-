#!/usr/bin/env node
/**
 * GitHub MCP Server (read-only)
 * -----------------------------------------------------------------------
 * Tier 2 (Phase 2) reference server: API-KEY auth, stdio transport,
 * read-only GitHub REST API access.
 *
 * This is the first "API-key auth head" template. The pattern to copy
 * for any future API-key server:
 *   - one env var holding the token (GITHUB_TOKEN)
 *   - a single `apiRequest()` wrapper that attaches the auth header,
 *     handles non-2xx responses, and rate-limit signals consistently
 *   - every tool calls that one wrapper instead of raw fetch
 *
 * Deliberately read-only: no create/update/delete/merge tools are
 * registered here. Write access is a Tier 4/5 decision (confirmation
 * steps, tighter scoping) — don't casually upgrade this file to add
 * writes without re-reading the security notes in the README.
 * -----------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? "https://api.github.com";
const MAX_RESULTS = numEnv("MAX_RESULTS", 20);

if (!GITHUB_TOKEN) {
  console.error(
    "FATAL: GITHUB_TOKEN is not set. Create a fine-grained personal access token " +
      "with read-only repository permissions and set it as GITHUB_TOKEN."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reusable "API-key head" wrapper — copy this pattern into any future
// API-key-authenticated server.
// ---------------------------------------------------------------------------
async function apiRequest(path: string, searchParams?: Record<string, string>) {
  const url = new URL(path, GITHUB_API_BASE);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-server/1.0",
    },
  });

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number(remaining) < 5) {
    console.error(`Warning: GitHub API rate limit nearly exhausted (${remaining} remaining).`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  return response.json();
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
const server = new McpServer({ name: "github-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "search_repositories",
  {
    title: "Search repositories",
    description: "Search public GitHub repositories by keyword.",
    inputSchema: {
      query: z.string().describe("GitHub search-syntax query, e.g. 'mcp server language:typescript'"),
    },
  },
  async ({ query }) => {
    try {
      const data: any = await apiRequest("/search/repositories", {
        q: query,
        per_page: String(MAX_RESULTS),
      });
      const items = (data.items ?? []).map((r: any) => ({
        full_name: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        url: r.html_url,
        language: r.language,
      }));
      return textResult({ total_count: data.total_count, results: items });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_repository",
  {
    title: "Get repository",
    description: "Get metadata for a single repository.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
    },
  },
  async ({ owner, repo }) => {
    try {
      const data: any = await apiRequest(`/repos/${owner}/${repo}`);
      return textResult({
        full_name: data.full_name,
        description: data.description,
        default_branch: data.default_branch,
        stars: data.stargazers_count,
        open_issues: data.open_issues_count,
        language: data.language,
        url: data.html_url,
      });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_issues",
  {
    title: "List issues",
    description: "List issues on a repository (excludes pull requests).",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).default("open"),
    },
  },
  async ({ owner, repo, state }) => {
    try {
      const data: any = await apiRequest(`/repos/${owner}/${repo}/issues`, {
        state,
        per_page: String(MAX_RESULTS),
      });
      const issues = data
        .filter((i: any) => !i.pull_request)
        .map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
          url: i.html_url,
        }));
      return textResult(issues);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_issue",
  {
    title: "Get issue",
    description: "Get a single issue's details, including body text.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number().int(),
    },
  },
  async ({ owner, repo, issue_number }) => {
    try {
      const data: any = await apiRequest(`/repos/${owner}/${repo}/issues/${issue_number}`);
      return textResult({
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        user: data.user?.login,
        url: data.html_url,
      });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_pull_requests",
  {
    title: "List pull requests",
    description: "List pull requests on a repository.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).default("open"),
    },
  },
  async ({ owner, repo, state }) => {
    try {
      const data: any = await apiRequest(`/repos/${owner}/${repo}/pulls`, {
        state,
        per_page: String(MAX_RESULTS),
      });
      const prs = data.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        base: p.base?.ref,
        head: p.head?.ref,
        url: p.html_url,
      }));
      return textResult(prs);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_pull_request",
  {
    title: "Get pull request",
    description: "Get a single pull request's details, including body and merge status.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      pull_number: z.number().int(),
    },
  },
  async ({ owner, repo, pull_number }) => {
    try {
      const data: any = await apiRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
      return textResult({
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        mergeable: data.mergeable,
        merged: data.merged,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        url: data.html_url,
      });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "search_code",
  {
    title: "Search code",
    description: "Search code across GitHub using GitHub's code search syntax.",
    inputSchema: {
      query: z.string().describe("e.g. 'registerTool repo:yourorg/yourrepo'"),
    },
  },
  async ({ query }) => {
    try {
      const data: any = await apiRequest("/search/code", {
        q: query,
        per_page: String(MAX_RESULTS),
      });
      const items = (data.items ?? []).map((c: any) => ({
        path: c.path,
        repository: c.repository?.full_name,
        url: c.html_url,
      }));
      return textResult({ total_count: data.total_count, results: items });
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
  console.error("github-mcp-server running in READ-ONLY mode.");
}

main().catch((err) => {
  console.error("Fatal error starting github-mcp-server:", err);
  process.exit(1);
});
