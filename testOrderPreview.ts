/**
 * Order preview smoke test — mirrors the exact payload shape confirmed
 * working against the sandbox via Python SDK debug logging:
 *
 *   POST /openapi/trade/stock/order/preview
 *   {
 *     "account_id": "...",
 *     "new_orders": [{
 *       "client_order_id": "<unique>",
 *       "symbol": "AAPL",
 *       "market": "US",
 *       "instrument_type": "EQUITY",   <- NOT "STOCK" despite the Python
 *                                         SDK's own enum suggesting that
 *       "side": "BUY",
 *       "order_type": "MARKET",
 *       "quantity": "1",
 *       "time_in_force": "DAY",         <- literal "DAY", not the SDK
 *                                          enum's odd "order day" value
 *       "entrust_type": "QTY",
 *       "support_trading_session": "CORE",
 *       "combo_type": "NORMAL"
 *     }]
 *   }
 *
 * This is a PREVIEW call — validates and estimates without executing
 * anything, safe to run freely.
 */

import "dotenv/config";
import crypto from "crypto";
import { WebullClient } from "./webullClient";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!; // sandbox account, NOT your real account IDs

  const order = {
    client_order_id: crypto.randomUUID().replace(/-/g, ""),
    symbol: "MSTZ",
    market: "US",
    instrument_type: "EQUITY",
    side: "BUY",
    order_type: "MARKET",
    quantity: "1",
    time_in_force: "DAY",
    entrust_type: "QTY",
    support_trading_session: "CORE",
    combo_type: "NORMAL",
  };

  console.log("Calling order preview endpoint...");
  console.log("account_id being sent:", JSON.stringify(accountId));
  console.log("full request body:", JSON.stringify({ account_id: accountId, new_orders: [order] }, null, 2));
  try {
    const result = await client.post("/openapi/trade/stock/order/preview", {
      account_id: accountId,
      new_orders: [order],
    });
    console.log("SUCCESS:", result);
  } catch (err) {
    console.error("FAILED:", err);
  }
}

main();
