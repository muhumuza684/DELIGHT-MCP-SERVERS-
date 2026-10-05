/**
 * oauth.ts — generic OAuth 2.1 (PKCE) authorization-code helper.
 * -----------------------------------------------------------------------
 * This is the "OAuth auth head" template. Copy this file into any future
 * OAuth-authenticated server and only change the ProviderConfig passed
 * into TokenManager — the flow itself (PKCE generation, local loopback
 * redirect listener, token exchange, refresh, on-disk persistence) is
 * provider-agnostic.
 *
 * What genuinely differs per provider (do NOT assume these are the same
 * without checking that provider's docs):
 *   - whether refresh tokens are issued at all (Notion's public OAuth
 *     apps generally do not rotate/expire tokens the way Google/Slack do)
 *   - whether PKCE is required, optional, or unsupported
 *   - token endpoint auth style (client_secret in body vs Basic auth
 *     header vs none)
 *   - scope string format (space-separated vs comma-separated)
 * -----------------------------------------------------------------------
 */

import http from "node:http";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

export interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string; // some providers require it even with PKCE
  scopes: string[];
  scopeSeparator?: string; // default " "
  redirectPort: number;
  tokenFile: string;
  extraAuthParams?: Record<string, string>;
  usesPkce?: boolean; // default true
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms; absent = doesn't expire / unknown
  raw?: Record<string, unknown>;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class TokenManager {
  constructor(private config: ProviderConfig) {}

  private async readTokens(): Promise<TokenSet | null> {
    try {
      const raw = await fs.readFile(this.config.tokenFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async writeTokens(tokens: TokenSet): Promise<void> {
    await fs.mkdir(path.dirname(this.config.tokenFile), { recursive: true });
    // 0600: only the owning user can read the token file — it holds live
    // credentials, treat it like a password.
    await fs.writeFile(this.config.tokenFile, JSON.stringify(tokens, null, 2), {
      mode: 0o600,
    });
  }

  /** Returns a valid access token, refreshing or running the full
   *  interactive authorize flow only if necessary. */
  async getAccessToken(): Promise<string> {
    let tokens = await this.readTokens();

    if (tokens && this.isExpired(tokens)) {
      if (tokens.refresh_token) {
        tokens = await this.refresh(tokens.refresh_token);
      } else {
        // Expired with nothing to refresh — treat as absent so we fall
        // through to a fresh interactive authorize() below, instead of
        // silently returning a stale token that will just fail downstream.
        tokens = null;
      }
    }

    if (!tokens) {
      tokens = await this.authorize();
    }

    return tokens.access_token;
  }

  private isExpired(tokens: TokenSet): boolean {
    if (!tokens.expires_at) return false; // unknown/non-expiring
    return Date.now() > tokens.expires_at - 60_000; // refresh 60s early
  }

  private async refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);

    const res = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `Token refresh failed (${res.status}). Delete the token file and re-authorize.`
      );
    }
    const data: any = await res.json();
    const tokens: TokenSet = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      raw: data,
    };
    await this.writeTokens(tokens);
    return tokens;
  }

  /** Runs the full interactive browser-based authorize flow once. Prints
   *  the URL to stderr — the person running the server (not the LLM
   *  client) must open it and approve access, exactly once per
   *  install/token-reset. */
  private async authorize(): Promise<TokenSet> {
    const usesPkce = this.config.usesPkce ?? true;
    const state = base64url(crypto.randomBytes(16));
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = usesPkce
      ? base64url(crypto.createHash("sha256").update(verifier).digest())
      : undefined;

    const redirectUri = `http://127.0.0.1:${this.config.redirectPort}/callback`;
    const authUrl = new URL(this.config.authorizeUrl);
    authUrl.searchParams.set("client_id", this.config.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      this.config.scopes.join(this.config.scopeSeparator ?? " ")
    );
    authUrl.searchParams.set("state", state);
    if (usesPkce) {
      authUrl.searchParams.set("code_challenge", challenge!);
      authUrl.searchParams.set("code_challenge_method", "S256");
    }
    for (const [k, v] of Object.entries(this.config.extraAuthParams ?? {})) {
      authUrl.searchParams.set(k, v);
    }

    console.error("\n=== Authorization required ===");
    console.error("Open this URL in a browser and approve access:\n");
    console.error(authUrl.toString());
    console.error(`\nWaiting for the redirect to 127.0.0.1:${this.config.redirectPort} ...\n`);

    const code = await this.waitForCallback(state);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    if (usesPkce) body.set("code_verifier", verifier);

    const res = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const tokens: TokenSet = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      raw: data,
    };
    await this.writeTokens(tokens);
    console.error("=== Authorized successfully. Tokens saved. ===\n");
    return tokens;
  }

  private waitForCallback(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "", `http://127.0.0.1:${this.config.redirectPort}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          error
            ? `<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`
            : `<html><body>Authorized. You can close this tab and return to your terminal.</body></html>`
        );
        server.close();

        if (error) return reject(new Error(`Authorization denied: ${error}`));
        if (state !== expectedState) return reject(new Error("State mismatch — possible CSRF. Aborting."));
        if (!code) return reject(new Error("No authorization code returned."));
        resolve(code);
      });

      server.listen(this.config.redirectPort, "127.0.0.1");

      // Don't hang forever if the user never completes the browser flow.
      setTimeout(() => {
        server.close();
        reject(new Error("Authorization timed out after 5 minutes."));
      }, 5 * 60 * 1000);
    });
  }
}
