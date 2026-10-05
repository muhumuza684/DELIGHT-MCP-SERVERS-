# DELIGHT MCP Servers

Built in Uganda by Bryt Matech UG.

A catalog of 10 ready-to-use Model Context Protocol (MCP) servers --
give an AI assistant like Claude real skills: read files, browse the
web, remember things, control a browser, and connect to GitHub,
Postgres, Stripe, Slack, Google Drive, and Notion.

**Live catalog page:** https://muhumuza684.github.io/DELIGHT-MCP-SERVERS-/

## The 10 servers

| Server | What it does | Setup needed |
|---|---|---|
| [filesystem-mcp-server](./filesystem-mcp-server) | Reads and organizes files for you | None |
| [fetch-mcp-server](./fetch-mcp-server) | Hands your AI any webpage, cleanly | None |
| [memory-mcp-server](./memory-mcp-server) | A memory that lasts beyond one chat | None |
| [playwright-mcp-server](./playwright-mcp-server) | Browses and clicks, like you would | None |
| [github-mcp-server](./github-mcp-server) | Reads your code and issues | GitHub token |
| [postgres-mcp-server](./postgres-mcp-server) | Ask your database in plain English | Database address |
| [stripe-mcp-server](./stripe-mcp-server) | Checks customers and payments | Stripe key |
| [slack-mcp-server](./slack-mcp-server) | Reads and sends Slack messages | One-time Slack sign-in |
| [google-drive-mcp-server](./google-drive-mcp-server) | Finds and reads your Drive files | One-time Google sign-in |
| [notion-mcp-server](./notion-mcp-server) | Searches and reads your Notion pages | One-time Notion sign-in |

Need something different? [create-mcp-server](./create-mcp-server) scaffolds
a new MCP server from the same templates these 10 were built from.

## How to download and use a server

**No git installed?** Click the green **Code** button at the top of this
repository, choose **Download ZIP**, extract it, and open the one folder
you need -- e.g. `filesystem-mcp-server`.

**With git:**
```bash
git clone https://github.com/muhumuza684/DELIGHT-MCP-SERVERS-.git
cd DELIGHT-MCP-SERVERS-/filesystem-mcp-server
```

Then, inside that folder:
```bash
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

That last command opens a browser test tool so you can confirm the
server works before connecting it to Claude or any other MCP client.
Each server's own README (inside its folder) has its exact setup steps
and which environment variables it needs, if any.

## Register a server with Claude Desktop

Add this to `claude_desktop_config.json`, then fully restart Claude
Desktop:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["C:\\path\\to\\filesystem-mcp-server\\dist\\index.js"]
    }
  }
}
```

## Contact

Bryt Matech UG -- Built in Uganda

- Phone: 0759 621 612
- Email: muhumuzabright26@gmail.com
- TikTok: @brytmatechug