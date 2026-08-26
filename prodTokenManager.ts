/**
 * Manages the production Webull OAuth-style access token used ONLY for
 * pushing screener picks to the real "Gap up" watchlist — trading/orders
 * never use this, sandbox stays fully separate.
 *
 * Confirmed live flow (mirrors webull/core/http/initializer/token/*.py in
 * the official Python SDK):
 *   POST /openapi/auth/token/create  {token?}  -> {token, expires, status}
 *   POST /openapi/auth/token/check   {token}   -> same shape
 *   POST /openapi/auth/token/refresh {token}   -> same shape
 * status is one of PENDING | NORMAL | INVALID | EXPIRED. A fresh
 * create_token call returns PENDING until the account holder approves the
 * request inside the real Webull app — CONFIRMED live, this is a genuine
 * one-time (or occasional) manual step, not something this code can
 * complete on its own. refresh_token extends an already-NORMAL token
 * without requiring re-approval — also confirmed live.
 *
 * The resulting token is cached in prod-token.json (gitignored — it's a
 * live credential) so a scheduled run doesn't need a human present unless
 * the cached token has actually gone invalid.
 */

import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";

const TOKEN_PATH = path.join(__dirname, "prod-token.json");
const REFRESH_BUFFER_MS = 5 * 24 * 60 * 60 * 1000; // refresh once <5 days from expiry, so a scheduled run never races expiry mid-flight

interface StoredToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expires: number;
  status: "PENDING" | "NORMAL" | "INVALID" | "EXPIRED";
}

function loadStoredToken(): StoredToken | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveToken(token: string, expiresAt: number): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token, expiresAt }, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a valid access token, refreshing or creating one as needed.
 * Throws with a clear, actionable message if a fresh PENDING request never
 * gets approved within the poll window — callers (stockScreener.ts) should
 * catch this and skip the watchlist push rather than fail the whole run.
 */
export async function getValidAccessToken(prodClient: WebullClient): Promise<string> {
  const stored = loadStoredToken();

  if (stored && stored.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return stored.token; // still comfortably valid, no network call needed
  }

  if (stored) {
    // Try to refresh first — extends a NORMAL token without needing
    // re-approval. Falls through to create_token below if this fails (e.g.
    // the stored token actually went INVALID/EXPIRED already).
    try {
      const refreshed = await prodClient.post<TokenResponse>("/openapi/auth/token/refresh", {
        token: stored.token,
      });
      if (refreshed.status === "NORMAL") {
        saveToken(refreshed.token, refreshed.expires);
        console.log(`[prod-token] refreshed, valid until ${new Date(refreshed.expires).toISOString()}`);
        return refreshed.token;
      }
    } catch (err) {
      console.warn("[prod-token] refresh failed, falling back to create_token:", err);
    }
  }

  const created = await prodClient.post<TokenResponse>("/openapi/auth/token/create", {});
  if (created.status === "NORMAL") {
    saveToken(created.token, created.expires);
    return created.token;
  }

  // PENDING — needs a human to approve inside the real Webull app. Poll a
  // handful of times in case someone's mid-approval, but don't block a
  // scheduled run indefinitely.
  console.warn(
    `[prod-token] new token is PENDING approval — open the Webull app and approve the ` +
      `access request before ${new Date(created.expires).toISOString()}`
  );
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(5000);
    const checked = await prodClient.post<TokenResponse>("/openapi/auth/token/check", {
      token: created.token,
    });
    if (checked.status === "NORMAL") {
      saveToken(checked.token, checked.expires);
      console.log(`[prod-token] approved, valid until ${new Date(checked.expires).toISOString()}`);
      return checked.token;
    }
    if (checked.status === "INVALID" || checked.status === "EXPIRED") {
      throw new Error(`[prod-token] token ${checked.status} before approval — rerun to request a new one`);
    }
  }

  throw new Error(
    "[prod-token] still PENDING after polling — approve the request in the Webull app, then rerun"
  );
}
