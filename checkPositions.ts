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

  const positions = await rest.get<any[]>("/openapi/assets/positions", { account_id: accountId });
  console.log("=== POSITIONS ===");
  console.log(JSON.stringify(positions, null, 2));

  const openOrders = await rest.get<any[]>("/openapi/trade/order/open", { account_id: accountId });
  console.log("=== OPEN ORDERS ===");
  console.log(JSON.stringify(openOrders, null, 2));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
