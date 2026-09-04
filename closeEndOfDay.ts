/**
 * One-off: reconcile broker state and force-close every open position via
 * the (now fixed) OrderManager.closeAllEndOfDay(). Used on 2026-08-19 to
 * manually flatten MRVI and PSNL after the scheduled 3:55pm ET EOD close
 * failed (see orderManager.ts closeAllEndOfDay/closeOneEndOfDay for the
 * race that caused it).
 */
import "dotenv/config";
import { WebullClient } from "./webullClient";
import { OrderManager } from "./orderManager";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;

  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const risk = new OrderManager(rest, {
    accountId,
    hardStopAmount: 0.15,
    breakevenActivationAmount: 0.2,
    trailingActivationAmount: 0.3,
    trailingStopAmount: 0.15,
    quantity: 300,
    minPrice: 1,
    maxPrice: 20,
    maxSpread: 0.03,
    minEntryVolume: 5_000,
    maxDailyLossUsd: 150,
  });

  console.log("Reconciling positions from broker...");
  await risk.reconcile();

  console.log("Closing all positions...");
  await risk.closeAllEndOfDay();

  console.log("Done.");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
