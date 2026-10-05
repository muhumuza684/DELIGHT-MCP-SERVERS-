#!/usr/bin/env node
/**
 * create-mcp-server — scaffolds a new MCP server from the body/auth-head
 * templates extracted from a real 10-server build (see the catalog's
 * Phase 5/6 READMEs for the evidence this was templated FROM).
 *
 * Interactive usage: npx create-mcp-server
 * Non-interactive/scriptable usage: see scaffold() below, exported for
 * anyone who wants to call this from another script/CI job instead of
 * answering prompts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(__dirname, "..", "templates");

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------
function toKebab(input) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}
function toEnvPrefix(input) {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/(^_+|_+$)/g, "");
}
function fill(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.split(`{{${key}}}`).join(value);
  return out;
}
function mergeDeps(basePkg, depsFragment) {
  return {
    ...basePkg,
    dependencies: { ...(basePkg.dependencies ?? {}), ...(depsFragment.dependencies ?? {}) },
    devDependencies: {
      ...(basePkg.devDependencies ?? {}),
      ...(depsFragment.devDependencies ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure scaffolding logic — no readline/prompting in here, so it's testable
// and scriptable independent of an interactive terminal.
//
// opts = {
//   rawName, orgName, displayName (optional), authType ('none'|'api-key'|'oauth'),
//   includeWriteTool (bool), providerName (for api-key/oauth), apiBase (for api-key),
//   cwd (optional, defaults to process.cwd())
// }
// returns { outDir, serverName }
// ---------------------------------------------------------------------------
export function scaffold(opts) {
  let serverSlug = toKebab(opts.rawName);
  const serverName = serverSlug.endsWith("-mcp-server") ? serverSlug : `${serverSlug}-mcp-server`;
  serverSlug = serverName.replace(/-mcp-server$/, "");

  const orgName = opts.orgName || "yourorg";
  const mcpName = `io.github.${orgName}/${serverName}`;
  const displayName =
    opts.displayName || serverName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const authType = opts.authType;
  if (!["none", "api-key", "oauth"].includes(authType)) {
    throw new Error(`Invalid authType "${authType}". Must be none, api-key, or oauth.`);
  }

  let envVarName = "";
  let apiBase = "";
  let providerEnvPrefix = "";
  if (authType === "api-key") {
    envVarName = `${toEnvPrefix(opts.providerName || "SERVICE")}_API_KEY`;
    apiBase = opts.apiBase || "https://api.example.com/";
  } else if (authType === "oauth") {
    providerEnvPrefix = toEnvPrefix(opts.providerName || "PROVIDER");
  }

  const cwd = opts.cwd || process.cwd();
  const outDir = path.resolve(cwd, serverName);
  if (existsSync(outDir)) {
    throw new Error(`Directory "${serverName}" already exists.`);
  }
  mkdirSync(path.join(outDir, "src"), { recursive: true });

  const vars = {
    SERVER_NAME: serverName,
    SERVER_SLUG: serverSlug,
    MCP_NAME: mcpName,
    DISPLAY_NAME: displayName,
    ENV_VAR_NAME: envVarName,
    API_BASE_PLACEHOLDER: apiBase,
    PROVIDER_ENV_PREFIX: providerEnvPrefix,
  };

  // --- common body files ---
  cpSync(path.join(TEMPLATES, "common", "tsconfig.json"), path.join(outDir, "tsconfig.json"));
  cpSync(path.join(TEMPLATES, "common", ".gitignore"), path.join(outDir, ".gitignore"));

  // --- auth-head src/index.ts ---
  const authDir = path.join(TEMPLATES, "auth", authType);
  let indexTs = fill(readFileSync(path.join(authDir, "index.ts.tmpl"), "utf-8"), vars);

  let writeToolRow = "";
  if (opts.includeWriteTool) {
    const snippet = readFileSync(path.join(TEMPLATES, "write-gate-snippet.ts.tmpl"), "utf-8");
    indexTs = indexTs.replace("// {{WRITE_TOOL_PLACEHOLDER}}", snippet.trim());
    writeToolRow = "| `example_write_tool` | **write** | Gated — disabled unless `ALLOW_WRITE=true` |";
  } else {
    indexTs = indexTs.replace("// {{WRITE_TOOL_PLACEHOLDER}}", "");
  }
  writeFileSync(path.join(outDir, "src", "index.ts"), indexTs);

  // --- oauth.ts, only for the oauth head ---
  if (authType === "oauth") {
    cpSync(path.join(authDir, "oauth.ts"), path.join(outDir, "src", "oauth.ts"));
  }

  // --- package.json (merge base + auth deps) ---
  const basePkg = JSON.parse(
    fill(readFileSync(path.join(TEMPLATES, "package.base.json.tmpl"), "utf-8"), vars)
  );
  const depsFragment = JSON.parse(readFileSync(path.join(authDir, "deps.json"), "utf-8"));
  writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(mergeDeps(basePkg, depsFragment), null, 2) + "\n"
  );

  // --- .env.example ---
  writeFileSync(
    path.join(outDir, ".env.example"),
    fill(readFileSync(path.join(authDir, ".env.example.tmpl"), "utf-8"), vars)
  );

  // --- server.json ---
  writeFileSync(
    path.join(outDir, "server.json"),
    fill(readFileSync(path.join(TEMPLATES, "server.json.tmpl"), "utf-8"), vars)
  );

  // --- README.md ---
  const authSection = fill(
    readFileSync(path.join(authDir, "README-auth-section.md.tmpl"), "utf-8"),
    vars
  );
  let readme = fill(readFileSync(path.join(TEMPLATES, "README.base.md.tmpl"), "utf-8"), vars);
  readme = readme.replace("{{AUTH_SECTION}}", authSection).replace("{{WRITE_TOOL_ROW}}", writeToolRow);
  writeFileSync(path.join(outDir, "README.md"), readme);

  return { outDir, serverName };
}

// ---------------------------------------------------------------------------
// Interactive prompting — only runs when this file is executed directly.
// ---------------------------------------------------------------------------
async function promptAndScaffold() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (question, fallback) => {
    const suffix = fallback ? ` (${fallback})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  };
  const askChoice = async (question, options) => {
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
    while (true) {
      const answer = (await rl.question(`Choose [1-${options.length}]: `)).trim();
      const idx = Number(answer) - 1;
      if (idx >= 0 && idx < options.length) return options[idx].value;
      console.log("Please enter a valid number.");
    }
  };
  const askYesNo = async (question, defaultYes = false) => {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer.startsWith("y");
  };

  console.log("=== create-mcp-server ===");
  console.log("Scaffolds a new server from templates proven across a 10-server build.\n");

  let rawName = await ask("Server name (kebab-case, e.g. 'acme-tickets')", "");
  while (!rawName) rawName = await ask("Server name is required", "");

  const orgName = await ask("GitHub org/username for the registry name", "yourorg");
  const displayName = await ask("Display name (used in README/comments)", "");

  const authType = await askChoice("Which auth head does this server need?", [
    { label: "None (local/public data — like filesystem, fetch)", value: "none" },
    { label: "API key (like github, postgres, stripe)", value: "api-key" },
    { label: "OAuth 2.1 (like slack, google-drive, notion)", value: "oauth" },
  ]);

  const includeWriteTool = await askYesNo(
    "Include a gated write-tool example (ALLOW_WRITE pattern)?",
    false
  );

  let providerName = "";
  let apiBase = "";
  if (authType === "api-key") {
    providerName = await ask("Provider/service name (for the env var)", "SERVICE");
    apiBase = await ask("API base URL", "https://api.example.com/");
  } else if (authType === "oauth") {
    providerName = await ask("Provider name (for env var prefix)", "PROVIDER");
  }

  rl.close();

  const { serverName } = scaffold({
    rawName,
    orgName,
    displayName,
    authType,
    includeWriteTool,
    providerName,
    apiBase,
  });

  console.log(`\nCreated ${serverName}/`);
  console.log("\nNext steps:");
  console.log(`  cd ${serverName}`);
  console.log("  npm install");
  console.log("  npm run build");
  console.log("  npx @modelcontextprotocol/inspector node dist/index.js");
  console.log("\nThen replace example_tool (and example_write_tool, if included) with real logic.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  promptAndScaffold().catch((err) => {
    console.error("create-mcp-server failed:", err.message || err);
    process.exit(1);
  });
}
