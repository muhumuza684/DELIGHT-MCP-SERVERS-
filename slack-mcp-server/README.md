<!-- mcp-name: io.github.yourorg/slack-mcp-server -->
# slack-mcp-server

_

Tier 4 reference MCP server — **OAuth 2.1**, stdio transport,
write-capable (gated). First of three OAuth servers in this phase —
see `oauth.ts` for the reusable "OAuth head" and the notes below for
what's actually Slack-specific.

## Tools

| Tool | Effect | Description |
|---|---|---|
| `list_channels` | read | List public channels |
| `get_channel_history` | read | Recent messages in a channel |
| `get_user_info` | read | Look up a user's profile |
| `post_message` | **write** | Post a message — disabled by default |

## Setup

1. Create a Slack app at https://api.slack.com/apps → "From scratch"
2. Under **OAuth & Permissions**, add redirect URL:
   `http://127.0.0.1:8734/callback`
3. Add bot token scopes: `channels:read`, `channels:history`,
   `chat:write`, `users:read`
4. Copy the **Client ID** and **Client Secret** from Basic Information

```bash
npm install
npm run build
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `SLACK_CLIENT_ID` | **yes** | From your Slack app |
| `SLACK_CLIENT_SECRET` | **yes** | From your Slack app |
| `OAUTH_REDIRECT_PORT` | no | Local port for the OAuth redirect (default 8734) |
| `TOKEN_FILE` | no | Where the access/refresh token is cached (default `./.slack-tokens.json`) |
| `ALLOW_WRITE` | no | Set to `true` to enable `post_message` (default: disabled) |

## First run — interactive authorization

On first `getAccessToken()` call, the server prints a URL to stderr.
Open it, approve the app in your workspace, and the local callback
server captures the code and exchanges it for a token automatically.
This only happens once — after that, the cached token in `TOKEN_FILE`
is reused (and refreshed if your app has token rotation enabled).

## Register with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "SLACK_CLIENT_ID": "xxx",
        "SLACK_CLIENT_SECRET": "xxx"
      }
    }
  }
}
```

## What's genuinely Slack-specific (don't assume Google/Notion match)

- **No PKCE**: Slack's OAuth v2 flow doesn't require it (`usesPkce: false`)
- **Refresh tokens are opt-in**: only issued if the Slack app has
  "token rotation" enabled in its settings — otherwise the bot token
  simply doesn't expire and refresh is never triggered
- **Error shape**: Slack's Web API returns HTTP 200 with
  `{ ok: false, error: "..." }` on failure rather than a non-2xx status
  in many cases — `apiCall()` checks `data.ok` explicitly instead of
  relying on `res.ok`

## Security notes

- `post_message` is a genuine side-effecting write and is **disabled by
  default** — you must explicitly set `ALLOW_WRITE=true`. Keep this
  default in place for any deployment where you're not certain every
  caller should be able to post as the bot.
- `TOKEN_FILE` holds a live access token — it's written with `0600`
  permissions, but treat it like any other credential (don't commit it,
  don't log its contents).
- Scope the bot token to only the four scopes above; don't add
  `channels:manage`, `chat:write.public`, or admin scopes unless a
  specific tool actually needs them.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
