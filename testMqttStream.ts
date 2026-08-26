/**
 * Live MQTT streaming smoke test — mirrors the exact confirmed-working
 * Python flow: connect MQTT -> wait -> HTTP subscribe -> receive + decode
 * real protobuf quote messages.
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { MarketDataStream } from "./marketDataStream";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";

  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const stream = new MarketDataStream(rest, {
    mqttHost: "data-api.sandbox.webull.com", // confirmed sandbox streaming host
    appKey: process.env.WEBULL_APP_KEY!,
    symbols: ["MSTZ"],
    subTypes: ["QUOTE", "TICK"],
    onQuote: (quote) => {
      console.log(
        `[quote] ${quote.symbol} @ ${new Date(quote.timestampMs).toISOString()} ` +
          `ask ${quote.askPrice}x${quote.askSize} bid ${quote.bidPrice}x${quote.bidSize}`
      );
    },
    onTick: (tick) => {
      console.log(
        `[tick] ${tick.symbol} @ ${tick.tradeTime} price=${tick.price} size=${tick.size} flag=${tick.flag}`
      );
    },
  });

  console.log("Connecting...");
  await stream.connect();

  // Keep the process alive to receive messages
  setTimeout(() => {
    console.log("Test complete, disconnecting.");
    stream.disconnect();
    process.exit(0);
  }, 20_000);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
