#!/usr/bin/env node
/**
 * Stripe MCP Server
 * -----------------------------------------------------------------------
 * Tier 5 (Phase 5) reference server #2 — API-key auth, stdio transport,
 * gated write access. This is the highest-stakes server in the whole
 * catalog: a wrong or hallucinated write tool call moves real money.
 *
 * Three independent safety layers, matching the plan's Tier 5 goal of
 * actually exercising the security checklist instead of just writing it
 * in a README:
 *   1. Live-mode guard: refuses to run against a live secret key
 *      (sk_live_...) unless ALLOW_LIVE_MODE=true is explicitly set —
 *      the default is that this server can only ever touch test data.
 *   2. Write gate: create_customer/create_refund are no-ops unless
 *      ALLOW_WRITE=true, same pattern as slack-mcp-server.
 *   3. Per-call confirmation: create_refund additionally requires the
 *      caller to pass confirm: true — a refund is hard to undo, so it
 *      gets a second, explicit opt-in beyond the server-level gate.
 * Don't collapse these into one flag "for simplicity" — they defend
 * against three different mistakes (wrong environment, wrong server
 * config, wrong single tool call).
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
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ALLOW_WRITE = (process.env.ALLOW_WRITE ?? "false").toLowerCase() === "true";
const ALLOW_LIVE_MODE = (process.env.ALLOW_LIVE_MODE ?? "false").toLowerCase() === "true";
const MAX_RESULTS = numEnv("MAX_RESULTS", 20);

if (!STRIPE_SECRET_KEY) {
  console.error("FATAL: STRIPE_SECRET_KEY is not set. Use a restricted key, not the full-access default.");
  process.exit(1);
}

const isLiveKey = STRIPE_SECRET_KEY.startsWith("sk_live_");
if (isLiveKey && !ALLOW_LIVE_MODE) {
  console.error(
    "FATAL: A live-mode secret key (sk_live_...) was provided but ALLOW_LIVE_MODE is not 'true'. " +
      "This server refuses to start against live Stripe data unless that's explicit. " +
      "Use a test key (sk_test_...) for development, or set ALLOW_LIVE_MODE=true deliberately."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stripe API wrapper — form-encoded, Bearer auth (Stripe's own convention)
// ---------------------------------------------------------------------------
async function stripeApi(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string>
) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  let body: URLSearchParams | undefined;
  if (method === "GET" && params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else if (params) {
    body = new URLSearchParams(params);
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe API error: ${data.error?.message ?? res.statusText}`);
  }
  return data;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function writeGateError() {
  return toolError(
    "Write access is disabled on this server (ALLOW_WRITE is not 'true'). " +
      "This is a deliberate default for a payments server — enable it explicitly."
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "stripe-mcp-server - Built in Uganda by Bryt Matech UG", version: "1" });

server.registerTool(
  "list_customers",
  {
    title: "List customers",
    description: "List customers, most recently created first.",
    inputSchema: {
      email: z.string().email().optional().describe("Filter by exact email"),
      limit: z.number().int().positive().max(100).default(MAX_RESULTS),
    },
  },
  async ({ email, limit }) => {
    try {
      const params: Record<string, string> = { limit: String(limit) };
      if (email) params.email = email;
      const data = await stripeApi("GET", "customers", params);
      const customers = data.data.map((c: any) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        created: new Date(c.created * 1000).toISOString(),
      }));
      return textResult(customers);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "get_customer",
  {
    title: "Get customer",
    description: "Get a single customer's details by ID.",
    inputSchema: { customer_id: z.string() },
  },
  async ({ customer_id }) => {
    try {
      const data = await stripeApi("GET", `customers/${customer_id}`);
      return textResult(data);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "list_charges",
  {
    title: "List charges",
    description: "List recent charges, optionally filtered to one customer.",
    inputSchema: {
      customer_id: z.string().optional(),
      limit: z.number().int().positive().max(100).default(MAX_RESULTS),
    },
  },
  async ({ customer_id, limit }) => {
    try {
      const params: Record<string, string> = { limit: String(limit) };
      if (customer_id) params.customer = customer_id;
      const data = await stripeApi("GET", "charges", params);
      const charges = data.data.map((c: any) => ({
        id: c.id,
        amount: c.amount,
        currency: c.currency,
        status: c.status,
        refunded: c.refunded,
        customer: c.customer,
        created: new Date(c.created * 1000).toISOString(),
      }));
      return textResult(charges);
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "create_customer",
  {
    title: "Create customer",
    description:
      "Create a new customer. WRITE — disabled unless ALLOW_WRITE=true.",
    inputSchema: {
      email: z.string().email(),
      name: z.string().optional(),
    },
  },
  async ({ email, name }) => {
    if (!ALLOW_WRITE) return writeGateError();
    try {
      const params: Record<string, string> = { email };
      if (name) params.name = name;
      const data = await stripeApi("POST", "customers", params);
      return textResult({ created: true, id: data.id, email: data.email });
    } catch (err) {
      return toolError((err as Error).message);
    }
  }
);

server.registerTool(
  "create_refund",
  {
    title: "Create refund",
    description:
      "Refund a charge, fully or partially. WRITE + DESTRUCTIVE — disabled unless " +
      "ALLOW_WRITE=true, AND requires confirm=true on every call as a second, " +
      "per-call opt-in (a refund is hard to reverse).",
    inputSchema: {
      charge_id: z.string(),
      amount_cents: z.number().int().positive().optional().describe("Omit to refund in full"),
      confirm: z.boolean().describe("Must be true — a deliberate second confirmation, not a default"),
    },
  },
  async ({ charge_id, amount_cents, confirm }) => {
    if (!ALLOW_WRITE) return writeGateError();
    if (!confirm) {
      return toolError(
        "Refunds require confirm=true on the call itself, in addition to the server's " +
          "ALLOW_WRITE setting. This is intentional — set confirm=true only once you're " +
          "certain this specific refund should happen."
      );
    }
    try {
      const params: Record<string, string> = { charge: charge_id };
      if (amount_cents) params.amount = String(amount_cents);
      const data = await stripeApi("POST", "refunds", params);
      return textResult({ refunded: true, id: data.id, amount: data.amount, status: data.status });
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
  console.error(
    `stripe-mcp-server running. mode=${isLiveKey ? "LIVE" : "test"}, write=${ALLOW_WRITE ? "ENABLED" : "disabled"}`
  );
}

main().catch((err) => {
  console.error("Fatal error starting stripe-mcp-server:", err);
  process.exit(1);
});
