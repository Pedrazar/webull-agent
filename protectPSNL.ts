/**
 * One-off: place a fresh protective STOP_LOSS for PSNL after startTrailing()
 * lost its stop to a cancel/place race and got stuck retrying forever
 * (2026-08-20). Stop set at $16.53 (breakeven, matching the last
 * successfully-logged breakeven_move) rather than the original $16.38 hard
 * stop, since the position already earned breakeven protection before the
 * bug hit.
 */
import "dotenv/config";
import { WebullClient } from "./webullClient";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const clientOrderId = crypto.randomUUID().replace(/-/g, "");
  const result = await rest.post("/openapi/trade/stock/order/place", {
    account_id: accountId,
    new_orders: [
      {
        entrust_type: "QTY",
        support_trading_session: "CORE",
        combo_type: "NORMAL",
        instrument_type: "EQUITY",
        market: "US",
        client_order_id: clientOrderId,
        symbol: "PSNL",
        side: "SELL",
        order_type: "STOP_LOSS",
        stop_price: "16.53",
        quantity: "300",
        time_in_force: "GTC",
      },
    ],
  });
  console.log("Placed:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
