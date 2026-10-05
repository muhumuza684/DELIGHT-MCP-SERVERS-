<!-- mcp-name: io.github.yourorg/stripe-mcp-server -->
# stripe-mcp-server

_

Tier 5 reference MCP server — **API-key auth, gated writes, real money**.
The highest-stakes server in this catalog. Read it fully before pointing
it at anything but a Stripe test account.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `list_customers` | read | List/search customers |
| `get_customer` | read | One customer's details |
| `list_charges` | read | Recent charges, optionally by customer |
| `create_customer` | **write** | Create a customer — gated |
| `create_refund` | **write + destructive** | Refund a charge — gated + per-call confirm |

## Setup

```bash
npm install
npm run build
```

Get a key from the Stripe Dashboard → Developers → API keys. **Strongly
prefer a [restricted key](https://stripe.com/docs/keys#limit-access)**
scoped to only `Customers` (read/write) and `Charges`/`Refunds`
(read/write) — not the default full-access secret key.

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | **yes** | `sk_test_...` (or `sk_live_...`, see below) |
| `ALLOW_WRITE` | no | Set `true` to enable `create_customer`/`create_refund` (default: disabled) |
| `ALLOW_LIVE_MODE` | no | Set `true` to allow a live-mode key to be used at all |
| `MAX_RESULTS` | no | Default page size for list tools (default 20) |

## Three independent safety layers — read this before changing any of them

1. **Live-mode guard**: the server checks the key prefix at boot. A
   `sk_live_...` key without `ALLOW_LIVE_MODE=true` causes it to refuse
   to start at all. Default behavior is "this server can only ever
   touch test data" — you have to opt into real money explicitly, at
   the server level, before it will even boot.
2. **Write gate**: `create_customer` and `create_refund` are no-ops
   unless `ALLOW_WRITE=true` — same pattern as `slack-mcp-server`'s
   `post_message` gate.
3. **Per-call confirmation**: `create_refund` additionally requires
   `confirm: true` on the tool call itself. This is on top of, not
   instead of, the write gate — a refund is hard to reverse, so it gets
   its own explicit opt-in every single time it's called, not just once
   at server-config time.

Do not collapse these three into one flag. They defend against three
different mistakes: the wrong Stripe account being connected at all,
the wrong server deployment having writes on, and one specific
tool call being wrong even though writes are correctly enabled.

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "stripe": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "STRIPE_SECRET_KEY": "sk_test_xxx"
      }
    }
  }
}
```

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
Use a `sk_test_...` key and Stripe's [test card numbers](https://stripe.com/docs/testing) for any exercising of write tools.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`

Note: given the stakes here, think carefully before publishing a
Stripe-connected server publicly — most teams building this
commercially keep it as a private/per-client deployment rather than a
public registry listing.
