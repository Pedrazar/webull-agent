/**
 * Minimal smoke test — proves the signature algorithm actually authenticates
 * against the sandbox before wiring up anything else. Run this first.
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  // TODO: replace this path with whatever the Python SDK actually calls —
  // see the "get the real path" step in the README before running this.
  const ACCOUNT_LIST_PATH = "/openapi/account/list"; // UNCONFIRMED guess

  console.log("Calling account list endpoint...");
  try {
    const result = await client.get(ACCOUNT_LIST_PATH);
    console.log("SUCCESS:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
    console.log("\nDiagnosis:");
    console.log("- 401/403 with a signature/auth error → signature algorithm issue");
    console.log("- 404 → the endpoint path is wrong, not the signature — check API Reference");
    console.log("- Network/DNS error → check WEBULL_BASE_URL and connectivity");
  }
}

main();
