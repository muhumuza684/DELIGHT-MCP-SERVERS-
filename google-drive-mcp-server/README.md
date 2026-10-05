<!-- mcp-name: io.github.yourorg/google-drive-mcp-server -->
# google-drive-mcp-server (read-only)

_

Tier 4 reference MCP server — **OAuth 2.1 with PKCE**, stdio transport,
read-only. Second of three OAuth servers in this phase — compare its
`oauth.ts` usage against `slack-mcp-server`'s to see what actually
differs between providers.

## Tools (all read-only)

| Tool | Description |
|---|---|
| `search_files` | Search by filename or full-text content |
| `list_files` | List files, optionally within a folder |
| `get_file_metadata` | Metadata for one file |
| `read_file_content` | Read text content — exports Docs/Sheets/Slides, downloads plain files |

## Setup

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth
   client ID → type **Web application**
2. Add authorized redirect URI: `http://127.0.0.1:8735/callback`
3. Enable the **Google Drive API** for the project
4. Copy the Client ID and Client Secret

```bash
npm install
npm run build
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | **yes** | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | **yes** | From Google Cloud Console |
| `OAUTH_REDIRECT_PORT` | no | Local OAuth redirect port (default 8735) |
| `TOKEN_FILE` | no | Where tokens are cached (default `./.google-tokens.json`) |
| `MAX_EXPORT_CHARS` | no | Cap on returned file content (default 50000) |

## First run — interactive authorization

Same pattern as `slack-mcp-server`: a URL is printed to stderr on first
use, you approve access in a browser, the local callback server on
`127.0.0.1:8735` captures the result automatically.

## What's genuinely Google-specific

- **PKCE is used** (unlike Slack) — `usesPkce` defaults to `true`
- **`access_type=offline` + `prompt=consent`** are required to get a
  refresh token at all — Google only issues one on the very first
  consent by default; `prompt=consent` forces re-issue if you ever
  need to re-authorize
- **Google Docs/Sheets/Slides have no direct binary content** — they're
  exported via a separate endpoint + target MIME type
  (`text/plain`, `text/csv`), unlike a normal uploaded file which
  downloads directly via `alt=media`. `read_file_content` branches on
  this automatically.

## Security notes

- Scope is `drive.readonly` only — this server cannot create, modify,
  or delete anything in Drive. Don't widen the scope without adding
  the same `ALLOW_WRITE`-style gate the Slack server uses for its
  write tool.
- `read_file_content` returns arbitrary document text back into the
  agent's context — treat it as untrusted data (indirect prompt
  injection risk), same caution as the fetch/GitHub servers.
- `TOKEN_FILE` is written with `0600` permissions; still treat it as a
  live credential.

## Publishing to the MCP registry

1. `mcp-publisher init` in this folder
2. Confirm `name` in `server.json` matches `mcpName` in `package.json`
3. `mcp-publisher validate`
4. `mcp-publisher login github`
5. `mcp-publisher publish`
