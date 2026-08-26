/**
 * Live quote/tick streaming via Webull's MQTT Data Streaming API.
 *
 * FULLY VERIFIED against api.sandbox.webull.com / data-api.sandbox.webull.com
 * via live testing (see quote.proto for the byte-level protobuf decodes that
 * confirmed both payload schemas). Key facts confirmed, several of which
 * contradicted reasonable-looking guesses made before live testing:
 *
 *  - MQTT auth is NOT derived from your app secret. The official SDK does:
 *      username_pw_set(app_key, uuid4().hex)
 *    i.e. username = your app key, password = a throwaway random UUID
 *    generated fresh per connection. The real security boundary is the
 *    signed HTTP subscribe call below, not the MQTT handshake itself.
 *
 *  - client_id on the MQTT connection = your session_id (any string you
 *    choose, e.g. a UUID) — this is what ties the MQTT socket to the
 *    HTTP subscribe call for the same session_id.
 *
 *  - The MQTT host is a COMPLETELY SEPARATE hostname from the HTTP API
 *    host, and sandbox has its own: data-api.sandbox.webull.com (vs
 *    api.sandbox.webull.com for HTTP). The SDK's own endpoint resolver
 *    does NOT auto-derive this for sandbox — it resolves to the
 *    PRODUCTION data host (data-api.webull.com) unless explicitly
 *    overridden. Confirmed by hitting INVALID_SESSION until this was
 *    fixed.
 *
 *  - Real flow, confirmed working end-to-end:
 *      1. Connect MQTT to data-api.sandbox.webull.com:1883 (or 8883 TLS),
 *         client_id = session_id, username = app_key, password = random.
 *      2. WAIT a few seconds after connect — subscribing immediately hits
 *         INVALID_SESSION ("Mqtt connection not exist for session..."),
 *         a real timing race confirmed live, not a hypothetical.
 *      3. POST /openapi/market-data/streaming/subscribe (normal signed
 *         HTTP call via WebullClient) with { session_id, symbols,
 *         category, sub_types }. sub_types values are UPPERCASE:
 *         "QUOTE", "SNAPSHOT", "TICK" — lowercase fails with
 *         UNSUPPORTED_SUB_TYPE.
 *      4. Messages arrive on topics matching their type: "quote", "tick",
 *         plus housekeeping topics "notice" and "echo" (heartbeat-like,
 *         confirmed to appear alongside real data — safely ignored below).
 *
 *  - QUOTE gives bid/ask snapshots (updates very frequently, no trade
 *    price). TICK gives the actual last-traded price/size (updates only
 *    on a real execution, much less frequently). Confirmed by comparing
 *    live payloads of both side by side — for bar construction matching
 *    a strategy backtested on real trade prices, TICK is the correct
 *    source, not QUOTE's bid/ask midpoint.
 *
 *  - Reconnection is NOT automatic at the subscription level even if
 *    mqtt.js reconnects the socket — the whole flow (steps 1-3) needs to
 *    re-run after any disconnect, including the propagation delay.
 *
 * Requires: npm install mqtt protobufjs
 */

import mqtt, { MqttClient } from "mqtt";
import protobuf from "protobufjs";
import path from "path";
import crypto from "crypto";
import { WebullClient } from "./webullClient";

export interface StreamConfig {
  mqttHost: string;
  mqttPort?: number;
  useTls?: boolean;
  appKey: string;
  symbols: string[];
  category?: string;
  subTypes?: string[];
  onQuote?: (quote: DecodedQuote) => void;
  onTick?: (tick: DecodedTick) => void;
}

export interface DecodedQuote {
  symbol: string;
  instrumentId: string;
  timestampMs: number;
  tradingSession: string;
  askPrice: number | null;
  askSize: number | null;
  bidPrice: number | null;
  bidSize: number | null;
}

export interface DecodedTick {
  symbol: string;
  instrumentId: string;
  timestampMs: number;
  tradingSession: string;
  tradeTime: string;
  price: number;
  size: number;
  flag: string;
  tradeTimestampMs: number;
}

const SUBSCRIBE_PROPAGATION_DELAY_MS = 3000;
const IGNORED_TOPICS = new Set(["notice", "echo"]);

export class MarketDataStream {
  private client: MqttClient | null = null;
  private reconnectAttempts = 0;
  private readonly maxBackoffMs = 30_000;
  private quoteType: protobuf.Type | null = null;
  private tickType: protobuf.Type | null = null;
  private sessionId: string;

  constructor(
    private restClient: WebullClient,
    private config: StreamConfig
  ) {
    this.sessionId = crypto.randomUUID();
  }

  private async loadProtoSchema(): Promise<void> {
    const root = await protobuf.load(path.join(__dirname, "quote.proto"));
    this.quoteType = root.lookupType("Quote");
    this.tickType = root.lookupType("Tick");
  }

  async connect(): Promise<void> {
    if (!this.quoteType || !this.tickType) {
      await this.loadProtoSchema();
    }

    const port = this.config.mqttPort ?? 1883;
    const protocol = this.config.useTls === false ? "mqtt" : "mqtts";
    const url = `${protocol}://${this.config.mqttHost}:${port}`;

    console.log(`[stream] attempting connection to ${url}`);

    this.client = mqtt.connect(url, {
      clientId: this.sessionId,
      username: this.config.appKey,
      password: crypto.randomUUID(),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 10_000,
    });

    const connectionWatchdog = setTimeout(() => {
      if (!this.client?.connected) {
        console.warn(
          `[stream] no connect/error/close event after 8s — likely a network-level hang (blocked port, wrong host, or firewall), not an application-level rejection`
        );
      }
    }, 8000);

    this.client.on("connect", () => {
      clearTimeout(connectionWatchdog);
      console.log("[stream] MQTT connected, session:", this.sessionId);
      this.reconnectAttempts = 0;
      setTimeout(() => {
        this.subscribeViaHttp().catch((err) =>
          console.error("[stream] HTTP subscribe failed:", err)
        );
      }, SUBSCRIBE_PROPAGATION_DELAY_MS);
    });

    this.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload);
    });

    this.client.on("close", () => {
      console.warn("[stream] MQTT connection closed — scheduling reconnect");
      this.scheduleReconnect();
    });

    this.client.on("error", (err) => {
      clearTimeout(connectionWatchdog);
      console.error("[stream] MQTT error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.maxBackoffMs);
    console.log(`[stream] reconnecting in ${delay}ms`);
    this.sessionId = crypto.randomUUID();
    setTimeout(() => this.connect(), delay);
  }

  private async subscribeViaHttp(): Promise<void> {
    await this.subscribeSymbols(this.config.symbols);
  }

  /**
   * Adds symbols to the live session's subscription. UNVERIFIED as of
   * 2026-08-19 whether the underlying HTTP endpoint is additive (adds to
   * whatever's already subscribed for this session_id) or replaces the
   * whole set — see testMqttResubscribe.ts, which was written to check this
   * empirically before any caller relies on it for anything but the
   * initial connect-time subscribe.
   */
  async subscribeSymbols(symbols: string[]): Promise<void> {
    const subTypes = this.config.subTypes ?? ["QUOTE", "TICK"];
    await this.restClient.post("/openapi/market-data/streaming/subscribe", {
      session_id: this.sessionId,
      symbols,
      category: this.config.category ?? "US_STOCK",
      sub_types: subTypes,
    });
    console.log(`[stream] subscribed to ${symbols.join(", ")} (${subTypes.join(", ")})`);
    if (subTypes.includes("QUOTE")) this.client?.subscribe("quote");
    if (subTypes.includes("TICK")) this.client?.subscribe("tick");
  }

  private handleMessage(topic: string, payload: Buffer): void {
    if (IGNORED_TOPICS.has(topic)) return;

    if (topic === "quote") {
      this.handleQuoteMessage(payload);
    } else if (topic === "tick") {
      this.handleTickMessage(payload);
    } else {
      console.warn(`[stream] unrecognized topic "${topic}", dropping message`);
    }
  }

  private handleQuoteMessage(payload: Buffer): void {
    if (!this.quoteType || !this.config.onQuote) return;
    try {
      const decoded = this.quoteType.decode(payload) as unknown as {
        basic?: { symbol?: string; instrumentId?: string; timestamp?: string; tradingSession?: string };
        ask?: { price?: string; size?: string };
        bid?: { price?: string; size?: string };
      };

      this.config.onQuote({
        symbol: decoded.basic?.symbol ?? "",
        instrumentId: decoded.basic?.instrumentId ?? "",
        timestampMs: decoded.basic?.timestamp ? parseInt(decoded.basic.timestamp, 10) : 0,
        tradingSession: decoded.basic?.tradingSession ?? "",
        askPrice: decoded.ask?.price ? parseFloat(decoded.ask.price) : null,
        askSize: decoded.ask?.size ? parseFloat(decoded.ask.size) : null,
        bidPrice: decoded.bid?.price ? parseFloat(decoded.bid.price) : null,
        bidSize: decoded.bid?.size ? parseFloat(decoded.bid.size) : null,
      });
    } catch (err) {
      console.error("[stream] failed to decode quote message", err);
    }
  }

  private handleTickMessage(payload: Buffer): void {
    if (!this.tickType || !this.config.onTick) return;
    try {
      const decoded = this.tickType.decode(payload) as unknown as {
        basic?: { symbol?: string; instrumentId?: string; timestamp?: string; tradingSession?: string };
        tradeTime?: string;
        price?: string;
        size?: string;
        flag?: string;
        tradeTimestamp?: string;
      };

      this.config.onTick({
        symbol: decoded.basic?.symbol ?? "",
        instrumentId: decoded.basic?.instrumentId ?? "",
        timestampMs: decoded.basic?.timestamp ? parseInt(decoded.basic.timestamp, 10) : 0,
        tradingSession: decoded.basic?.tradingSession ?? "",
        tradeTime: decoded.tradeTime ?? "",
        price: decoded.price ? parseFloat(decoded.price) : 0,
        size: decoded.size ? parseFloat(decoded.size) : 0,
        flag: decoded.flag ?? "",
        tradeTimestampMs: decoded.tradeTimestamp ? parseInt(decoded.tradeTimestamp, 10) : 0,
      });
    } catch (err) {
      console.error("[stream] failed to decode tick message", err);
    }
  }

  disconnect(): void {
    this.client?.end(true);
  }
}
