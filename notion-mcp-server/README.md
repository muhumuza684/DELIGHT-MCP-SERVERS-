<!-- mcp-name: io.github.yourorg/notion-mcp-server -->
# notion-mcp-server (read-only)

_

Tier 4 reference MCP server — **OAuth 2.1 (non-standard token exchange)**,
stdio transport, read-only. Third of three OAuth servers in this phase —
and the one that actually broke the "generic OAuth2" assumptions baked
into `oauth.ts`, which is exactly the point of building three before
templating anything (see the Phase 4 README).

## Tools (all read-only)

| Tool | Description |
|---|---|
| `search` | Search pages/databases the integration can see |
| `get_page` | Get a page's properties by ID |
| `get_page_content` | Get a page's body as flattened plain-text blocks |
| `query_database` | Query a database's rows |

## Setup

1. https://www.notion.so/my-integrations → **New integration** → type
   **Public** (required for OAuth; internal integrations use a static
   token instead and skip this whole flow)
2. Set the redirect URI: `http://127.0.0.1:8736/callback`
3. Copy the OAuth **Client ID** and **Client Secret**

```bash
npm install
npm run build
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `NOTION_CLIENT_ID` | **yes** | From your Notion public integration |
| `NOTION_CLIENT_SECRET` | **yes** | From your Notion public integration |
| `OAUTH_REDIRECT_PORT` | no | Local OAuth redirect port (default 8736) |
| `TOKEN_FILE` | no | Where the token is cached (default `./.notion-tokens.json`) |

## First run — interactive authorization

Same URL-print-and-wait pattern as the other two servers. The user picks
which pages/databases to share with the integration during this step —
Notion's access model is "explicitly shared with the integration," not
scope-based like Google/Slack.

## What's genuinely Notion-specific (this is the important one)

- **Token exchange uses Basic auth + JSON**, not form-urlencoded with
  credentials in the body — `oauth.ts` gained a `tokenAuthStyle:
  "basic_json"` option specifically because of this. Without it, the
  shared OAuth module (written against Slack/Google's shape) silently
  fails against Notion.
- **No real scopes**: Notion's OAuth doesn't negotiate scopes the way
  Google/Slack do — access is capability-based (set in the integration's
  dashboard) and page/database-based (the user explicitly picks what to
  share during authorization).
- **Tokens are effectively long-lived**: no refresh token is typically
  issued for public integrations; access lasts until the user revokes
  it from their Notion settings.
- **`Notion-Version` header is required on every API call** — unrelated
  to OAuth itself, but a common first-integration mistake.

## Security notes

- Access is scoped to whatever pages/databases the user chose to share
  during authorization — this server cannot see anything beyond that,
  regardless of what a tool call asks for.
- Treat returned page/block content as untrusted data if it's fed back
  into further agent reasoning — same indirect-injection caution as
  every other read tool in this catalog.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
