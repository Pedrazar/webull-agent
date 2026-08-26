/**
 * Smoke test: does POSTing /openapi/market-data/streaming/subscribe a
 * second time (same session_id, a different/smaller symbol list) ADD to
 * the existing subscription, or REPLACE it?
 *
 * Uses its own session, separate from the live WebullAgentStart process —
 * does not touch it. Runs against real gap-up movers from today's actual
 * watchlist.json so there's a real chance of live ticks in a short window.
 *
 * Phase 1: subscribe to symbol A only, count ticks per symbol for 20s.
 * Phase 2: subscribeSymbols([symbol B]) only (NOT A), count ticks per
 *          symbol for another 20s.
 * If A's tick count keeps growing in phase 2 -> additive.
 * If A's ticks stop growing in phase 2 -> replace (must always resend the
 * full desired symbol set, not just the delta).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";
import { MarketDataStream } from "./marketDataStream";

async function main() {
  const watchlistPath = path.join(__dirname, "watchlist.json");
  const { symbols } = JSON.parse(fs.readFileSync(watchlistPath, "utf8")) as { symbols: string[] };
  if (symbols.length < 2) {
    console.error(`Need at least 2 symbols in watchlist.json to test, got: ${symbols.join(", ")}`);
    process.exit(1);
  }
  const [symbolA, symbolB] = symbols;
  console.log(`Testing with A=${symbolA}, B=${symbolB}`);

  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const counts: Record<string, number> = {};
  const bump = (symbol: string) => {
    counts[symbol] = (counts[symbol] ?? 0) + 1;
  };

  const stream = new MarketDataStream(rest, {
    mqttHost: "data-api.sandbox.webull.com",
    appKey: process.env.WEBULL_APP_KEY!,
    symbols: [symbolA],
    subTypes: ["QUOTE", "TICK"],
    onTick: (t) => bump(t.symbol),
    onQuote: (q) => bump(q.symbol),
  });

  console.log("Connecting, subscribing to A only...");
  await stream.connect();

  await new Promise((r) => setTimeout(r, 20_000));
  console.log("--- after phase 1 (A only) ---", counts);
  const aCountAfterPhase1 = counts[symbolA] ?? 0;

  console.log(`Now subscribing to B (${symbolB}) only, NOT re-sending A...`);
  await stream.subscribeSymbols([symbolB]);

  await new Promise((r) => setTimeout(r, 20_000));
  console.log("--- after phase 2 (B added, A not resent) ---", counts);
  const aCountAfterPhase2 = counts[symbolA] ?? 0;
  const bCountAfterPhase2 = counts[symbolB] ?? 0;

  console.log("\n=== RESULT ===");
  console.log(`A (${symbolA}) messages: phase1=${aCountAfterPhase1} phase2Total=${aCountAfterPhase2}`);
  console.log(`B (${symbolB}) messages: phase2Total=${bCountAfterPhase2}`);
  if (aCountAfterPhase2 > aCountAfterPhase1) {
    console.log("A kept receiving messages after re-subscribing with only B -> ADDITIVE semantics confirmed.");
  } else if (aCountAfterPhase1 > 0) {
    console.log("A stopped receiving messages after re-subscribing with only B -> REPLACE semantics (must resend full set).");
  } else {
    console.log("INCONCLUSIVE: A never received any messages even in phase 1 (no live activity in this window) — re-run.");
  }
  if (bCountAfterPhase2 === 0) {
    console.log("NOTE: B never received any messages either — could be inconclusive due to low activity, not just semantics.");
  }

  stream.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
