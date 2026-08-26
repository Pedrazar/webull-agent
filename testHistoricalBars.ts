/**
 * Second endpoint smoke test — historical bars. Confirms the signature
 * algorithm generalizes beyond the account-list call, and doubles as a
 * real check of the exact response shape your signal engine needs to parse.
 *
 * Endpoint and param format confirmed via Python SDK debug log:
 *   GET /openapi/market-data/stock/bars?symbol=AAPL&category=US_STOCK&timespan=M1&count=10
 *
 * IMPORTANT: all numeric fields (open/close/high/low/volume) come back as
 * STRINGS, not numbers — e.g. "open": "303.6500". Must parseFloat() before
 * any arithmetic (EMA calculation, comparisons, etc).
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";

interface RawBarResponse {
  tickerId: string;
  symbol: string;
  time: string; // ISO string with milliseconds, e.g. "2026-08-17T16:48:00.000+0000"
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  trading_session: string;
  instrument_id: string;
}

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  console.log("Calling historical bars endpoint...");
  try {
    const bars = await client.get<RawBarResponse[]>(
      "/openapi/market-data/stock/bars",
      {
        symbol: "MSTZ",
        category: "US_STOCK",
        timespan: "M1",
        count: "10",
      }
    );

    console.log(`SUCCESS: received ${bars.length} bars`);
    console.log("Most recent bar (raw):", bars[0]);

    // Confirm the string -> number parsing works as expected
    const parsed = bars.map((b) => ({
      time: b.time,
      close: parseFloat(b.close),
    }));
    console.log("Parsed closes:", parsed.map((p) => p.close));
  } catch (err) {
    console.error("FAILED:", err);
  }
}

main();
