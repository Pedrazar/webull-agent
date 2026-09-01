/**
 * Full agent wiring: live quotes -> 1-min bars -> EMA-9/20 signal -> risk-managed
 * order execution, against Webull's SANDBOX environment.
 *
 * Every piece here has been individually verified live (see comments in
 * webullClient.ts, marketDataStream.ts, orderManager.ts, signalEngine.ts for
 * what was proven vs. what's still a reasonable-but-unconfirmed assumption).
 * This file is the first time they're wired together — treat this as a
 * fresh integration, not something proven end-to-end yet. Watch the console
 * output closely on first run and be ready to Ctrl+C.
 *
 * This targets the SANDBOX account (paper trading) — the accountId below is
 * a sandbox test account, not a real funded account. Do not swap in a real
 * account ID without separately re-verifying every order call against
 * production, since sandbox and production are NOT guaranteed to behave
 * identically beyond what's been tested here.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";
import { MarketDataStream } from "./marketDataStream";
import { BarAggregator, RawBar } from "./barAggregator";
import { SignalEngine } from "./signalEngine";
import { OrderManager } from "./orderManager";
import { runScreener } from "./stockScreener";
import { logTradeEvent } from "./tradeLogger";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Reads whatever watchlist.json currently holds — a last-resort fallback
// for when a live screener run (see loadOrRunScreener below) fails or
// finds nothing, falling further back to MSTZ, CONFIRMED live against
// api.sandbox.webull.com to work in sandbox and sit inside the $1-$20
// minPrice/maxPrice filter below (unlike AAPL at ~$310, which the sandbox
// docs otherwise steer you toward).
function loadWatchlist(): string[] {
  const watchlistPath = path.join(__dirname, "watchlist.json");
  try {
    const raw = fs.readFileSync(watchlistPath, "utf8");
    const parsed = JSON.parse(raw) as { generatedAt: string; symbols: string[] };
    if (Array.isArray(parsed.symbols) && parsed.symbols.length > 0) {
      console.log(`Loaded watchlist (generated ${parsed.generatedAt}): ${parsed.symbols.join(", ")}`);
      return parsed.symbols;
    }
  } catch (err) {
    console.warn(`Could not read watchlist.json (${(err as Error).message}), falling back to default symbol`);
  }
  return ["MSTZ"];
}

// Runs the screener in-process (removes the dependency on a separate
// scheduled screener process having already written watchlist.json — added
// 2026-08-25 for the move to a single bounded GitHub Actions job, see
// CLAUDE.md's Remote hosting section). Falls back to whatever's already on
// disk (loadWatchlist's file-read + MSTZ fallback) if the live run fails or
// comes back empty.
async function loadOrRunScreener(rest: WebullClient): Promise<string[]> {
  try {
    const symbols = await runScreener(rest);
    if (symbols.length > 0) return symbols;
    console.warn("[watchlist] screener returned no picks, falling back to watchlist.json");
  } catch (err) {
    console.warn(`[watchlist] screener run failed (${(err as Error).message}), falling back to watchlist.json`);
  }
  return loadWatchlist();
}

// Full SYMBOLS stays subscribed/seeded as before (existing positions in any
// of them still need bar/signal + exit management) — this just gates which
// symbols are allowed to open NEW positions. watchlist.json is already
// ranked by relative_volume_10d desc (see stockScreener.ts), so "top N" is
// just the first N entries.
const ACTIVE_SYMBOL_COUNT = Number(process.env.AGENT_ACTIVE_SYMBOL_COUNT ?? 2);
const WATCHLIST_RECHECK_MS = 60 * 60_000; // re-rank top N hourly

// Always entry-eligible regardless of watchlist ranking — on top of, not
// instead of, the top-N watchlist symbols below. Added 2026-08-22.
const ALWAYS_ACTIVE_SYMBOLS = (process.env.AGENT_ALWAYS_ACTIVE_SYMBOLS ?? "MSTZ,NVTS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function topActiveSymbols(symbols: string[]): Set<string> {
  return new Set([...symbols.slice(0, ACTIVE_SYMBOL_COUNT), ...ALWAYS_ACTIVE_SYMBOLS]);
}

// Populated inside main() once the screener has actually run — nothing
// reads these before then.
let activeSymbols = new Set<string>();
let trackedSymbols = new Set<string>();

// Shared America/New_York clock — DST-safe (asks Intl directly rather than
// hardcoding a UTC offset, which would silently drift wrong across the
// EST/EDT transition). Used by the market-open gate below and the EOD
// check further down.
const nyTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyTimeOf(date: Date): { hour: number; minute: number } {
  const parts = nyTimeFormatter.formatToParts(date);
  return {
    hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "-1", 10),
    minute: parseInt(parts.find((p) => p.type === "minute")?.value ?? "-1", 10),
  };
}

function nyNow(): { hour: number; minute: number } {
  return nyTimeOf(new Date());
}

/** True for a bar timestamped at or after today's 9:30am ET regular-hours open. */
function isAtOrAfterMarketOpen(date: Date): boolean {
  const { hour, minute } = nyTimeOf(date);
  return hour > 9 || (hour === 9 && minute >= 30);
}

/**
 * True at or after the 3:15pm ET EOD-close target — "at or after", not an
 * exact-minute match, so a process that starts mid-window (e.g. a backup
 * `schedule` trigger that queued behind the concurrency lock and only got
 * to start at 3:16pm) still catches it instead of sailing past both this
 * and exitIfPastClose()'s later 3:30pm threshold. See the 2026-09-01
 * incident in CLAUDE.md's Remote hosting section: an exact `minute === 15`
 * check missed a queued run that started after :15 had already ticked by,
 * which went on to connect to the live stream and could have placed a
 * duplicate entry against a position the primary session had already
 * closed.
 */
function isPastEodCloseTime(date: Date): boolean {
  const { hour, minute } = nyTimeOf(date);
  return hour > 15 || (hour === 15 && minute >= 15);
}

/**
 * Bounded-job mode (GitHub Actions, added 2026-08-25): the cron trigger
 * fires at a single fixed UTC time safely before market open in both EDT
 * and EST (see CLAUDE.md's Remote hosting section) rather than trying two
 * DST-dependent triggers, so a fresh process can start up to ~90 minutes
 * before the open. Exits immediately, before doing any real work, if
 * started already past today's effective 3:30pm ET close — a stale/late
 * trigger, or (deliberately) the safe way to smoke-test the workflow's
 * plumbing with zero trading risk.
 */
function exitIfPastClose(): void {
  const { hour, minute } = nyNow();
  if (hour > 15 || (hour === 15 && minute >= 30)) {
    console.log(
      `[startup] already past today's 3:30 PM ET close (NY time ${hour}:${String(minute).padStart(2, "0")}), nothing to do — exiting`
    );
    process.exit(0);
  }
}

/** Polls real NY time until the regular session has opened (9:30am ET). */
async function waitForMarketOpen(): Promise<void> {
  for (;;) {
    const { hour, minute } = nyNow();
    if (isAtOrAfterMarketOpen(new Date())) {
      console.log(`[startup] market open (NY time ${hour}:${String(minute).padStart(2, "0")}), proceeding`);
      return;
    }
    console.log(`[startup] waiting for market open (NY time ${hour}:${String(minute).padStart(2, "0")})...`);
    await sleep(30_000);
  }
}

interface HistoricalBar {
  time: string; // ISO string with explicit UTC offset, e.g. "2026-08-17T16:48:00.000+0000"
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Shared by the startup seeding loop and the hourly dynamic-add path.
 *
 * Splits the fetched history at today's 9:30am ET open: bars from BEFORE
 * the open are pure EMA warmup (silently folded in via signals.seed() — no
 * meaningful entry decision exists before the market opens). Bars AT OR
 * AFTER the open are replayed through the REAL signals.onBarClose()
 * detection path instead, one at a time in order, so a late job start (see
 * CLAUDE.md's Remote hosting section, the 2026-08-26/27 incidents) can no
 * longer silently swallow a genuine crossover the way seed()-only always
 * did — seed() updates ema9/ema20 but never touches prevEma9/prevEma20, so
 * the crossedUp/crossedDown check on the first live bar after a seed-only
 * catch-up could never fire even if a real cross happened during the gap.
 * Any LONG_ENTRY found this way is logged (missed_entry trade event) but
 * deliberately NEVER traded — a crossover caught minutes late means the
 * intended entry price is already gone (user's explicit call, 2026-08-27):
 * log-only, don't chase it at a stale/current price with a stop sized for
 * the original setup.
 */
async function seedSymbol(rest: WebullClient, signals: SignalEngine, symbol: string): Promise<void> {
  const bars = await rest.get<HistoricalBar[]>("/openapi/market-data/stock/bars", {
    symbol,
    category: "US_STOCK",
    timespan: "M1",
    count: "30",
  });
  // CONFIRMED: response is most-recent-first — reverse for oldest-to-newest replay.
  const oldestFirst = [...bars].reverse();
  const preOpen = oldestFirst.filter((b) => !isAtOrAfterMarketOpen(new Date(b.time)));
  const sessionBars = oldestFirst.filter((b) => isAtOrAfterMarketOpen(new Date(b.time)));

  signals.seed(symbol, preOpen.map((b) => parseFloat(b.close)));

  for (const b of sessionBars) {
    const bar: RawBar = {
      time: new Date(b.time).getTime(),
      open: parseFloat(b.open),
      high: parseFloat(b.high),
      low: parseFloat(b.low),
      close: parseFloat(b.close),
      volume: parseFloat(b.volume),
    };
    const signal = signals.onBarClose(symbol, bar, (msg) => console.log(`  ${msg}`));
    if (signal === "LONG_ENTRY") {
      console.log(
        `  [missed-entry] ${symbol} crossed up at ${b.time} (close ${bar.close}) during catch-up replay — NOT traded, price is stale`
      );
      logTradeEvent({ event: "missed_entry", symbol, barTime: b.time, price: bar.close, volume: bar.volume || null });
    }
  }

  console.log(
    `  ${symbol}: seeded ${preOpen.length} pre-open close(s), replayed ${sessionBars.length} session bar(s) for missed-entry detection`
  );
}

async function main() {
  exitIfPastClose();

  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;

  if (!accountId) {
    throw new Error("WEBULL_SANDBOX_ACCOUNT_ID must be set in .env — refusing to guess an account.");
  }

  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const SYMBOLS = await loadOrRunScreener(rest);
  activeSymbols = topActiveSymbols(SYMBOLS);
  console.log(`Active (entry-eligible) symbols: ${[...activeSymbols].join(", ")}`);

  await waitForMarketOpen();

  // 0.003 = 0.3% minimum EMA-9/EMA-20 separation to count a crossover —
  // filters out marginal, flat-market whipsaws. See signalEngine.ts for
  // the incident that motivated this (a deliberate deviation from the
  // Script Editor source, not derived from it).
  const signals = new SignalEngine(0.003);

  const risk = new OrderManager(rest, {
    accountId,
    // Matches the Webull Script Editor strategy (EMATrailingStopStrategy)
    // exactly — flat dollar amounts, not a percentage of price.
    hardStopAmount: 0.15,
    breakevenActivationAmount: 0.2,
    trailingActivationAmount: 0.3,
    trailingStopAmount: 0.1,
    quantity: 300,
    minPrice: 1,
    maxPrice: 20,
    maxSpread: 0.03,
    maxDailyLossUsd: 120,
  });

  // Reconcile against real broker state BEFORE doing anything else — a
  // restart should never think it's flat when it's actually holding shares.
  console.log("Reconciling positions from broker...");
  const reconciledSymbols = await risk.reconcile();

  // A reconciled position's symbol might not be in today's watchlist at all
  // (e.g. the watchlist rotated since it was entered) — it still needs live
  // price data or breakeven/trailing management never runs for it again,
  // even though its stop order keeps resting fine at the broker. See
  // reconcile()'s docstring for the incident this fixes.
  const startupSymbols = [...new Set([...SYMBOLS, ...reconciledSymbols, ...ALWAYS_ACTIVE_SYMBOLS])];
  trackedSymbols = new Set(startupSymbols);
  if (reconciledSymbols.some((s) => !SYMBOLS.includes(s))) {
    console.log(
      `Extending live tracking beyond today's watchlist for reconciled position(s): ` +
        `${reconciledSymbols.filter((s) => !SYMBOLS.includes(s)).join(", ")}`
    );
  }

  // Warm up EMA state from real historical bars — CONFIRMED endpoint/shape.
  console.log("Seeding EMA state from historical bars...");
  for (const symbol of startupSymbols) {
    await seedSymbol(rest, signals, symbol);
  }

  // Catch a start that lands in the narrow window between the EOD-close
  // target (3:15pm ET) and exitIfPastClose()'s later 3:30pm threshold —
  // e.g. a backup `schedule` trigger queued behind the concurrency lock
  // that only gets to start once the primary session's already done for
  // the day. Checked here, before ever connecting to the live stream, so
  // there's no window where a live crossover could place a duplicate
  // entry against a position the primary session already closed out.
  if (isPastEodCloseTime(new Date())) {
    console.log(
      "[eod] already past the 3:15 PM ET close by the time startup finished — closing out and exiting without going live"
    );
    await risk.closeAllEndOfDay();
    await risk.checkForFills();
    console.log("[eod] trading day complete, shutting down");
    process.exit(0);
  }

  // Latest bid/ask per symbol, from the QUOTE stream — used only to gate
  // entries on spread, not for bar construction (TICK/trade price still
  // drives the bars and the signal, unchanged).
  const latestQuotes = new Map<string, { bid: number; ask: number }>();

  // Latest closed-bar volume per symbol — entries can grab this directly
  // from the triggering bar, but exits (stop/trailing fills, EOD closes)
  // are detected by risk.checkForFills()/closeAllEndOfDay() polling order
  // status independently of bar closes, so they have no bar of their own
  // to read volume from. This map, passed into OrderManager by reference,
  // is how they get "most recent known volume as of the fill" instead.
  // Added 2026-08-21 so the daily review can report volume at entry/exit.
  const latestBarVolume = new Map<string, number>();
  risk.setVolumeSource(latestBarVolume);

  const aggregator = new BarAggregator((symbol, bar) => {
    latestBarVolume.set(symbol, bar.volume);
    const signal = signals.onBarClose(symbol, bar);
    console.log(
      `[bar] ${symbol} close=${bar.close.toFixed(2)} vol=${bar.volume} -> signal=${signal}`
    );

    if (signal === "LONG_ENTRY") {
      if (!activeSymbols.has(symbol)) {
        console.log(`[signal] LONG_ENTRY on ${symbol} @ ${bar.close} ignored — not in top ${ACTIVE_SYMBOL_COUNT}`);
      } else {
        console.log(`[signal] LONG_ENTRY on ${symbol} @ ${bar.close}`);
        const quote = latestQuotes.get(symbol);
        const spread = quote ? +(quote.ask - quote.bid).toFixed(4) : null;
        risk.enterLong(symbol, bar.close, spread).catch((err) =>
          console.error(`[risk] enterLong failed for ${symbol}:`, err)
        );
      }
    }
    // Price-update-driven phase transitions (breakeven/trailing) run on
    // every bar close too, for any already-open position on this symbol.
    // Uses the bar HIGH, not close — matches the Script Editor strategy,
    // which arms these stages off intrabar highs.
    risk.onPriceUpdate(symbol, bar.high).catch((err) =>
      console.error(`[risk] onPriceUpdate failed for ${symbol}:`, err)
    );
  });

  const stream = new MarketDataStream(rest, {
    mqttHost: "data-api.sandbox.webull.com", // CONFIRMED sandbox streaming host
    appKey: process.env.WEBULL_APP_KEY!,
    symbols: startupSymbols,
    // TICK still drives bars/signal (real trade price, matches backtest).
    // QUOTE added purely to gate entries on spread — bid/ask never touches
    // bar construction.
    subTypes: ["TICK", "QUOTE"],
    onTick: (tick) => {
      aggregator.onTick(tick);
    },
    onQuote: (quote) => {
      if (quote.bidPrice !== null && quote.askPrice !== null) {
        latestQuotes.set(quote.symbol, { bid: quote.bidPrice, ask: quote.askPrice });
      }
    },
  });

  console.log("Connecting to live stream...");
  await stream.connect();

  // EOD close check — poll once a minute rather than relying on bar events,
  // so it still fires during a low-volume lull near the close. Reuses the
  // shared DST-safe nyNow() defined above.
  setInterval(() => {
    // Moved up 30 min from the original 3:55pm ET (2026-08-25, deliberate
    // choice: the last half hour of the session isn't worth trading), then
    // another 10 min from 3:25pm to 3:15pm ET (2026-08-31) — GitHub's
    // hosted-runner hard cap is 360 min total per job, and a 9:15am ET
    // cron-job.org trigger plus a 9:30am-3:25pm ET session plus checkout/
    // npm-ci/commit overhead added up to ~370 min, so the job got hard-
    // killed by GitHub before ever reaching its own EOD close (confirmed
    // live 2026-08-31: killed at 3:05pm ET, 20 min before the close would
    // have run — harmless that day only because no position was open at
    // the time). See CLAUDE.md's Remote hosting section for the full
    // incident and margin math.
    if (isPastEodCloseTime(new Date())) {
      console.log("[eod] 3:15 PM ET reached, closing all positions");
      (async () => {
        try {
          await risk.closeAllEndOfDay();
          // One more fill check right after — catches anything that filled
          // independently in the few seconds around the EOD close itself.
          await risk.checkForFills();
        } catch (err) {
          console.error("[eod] close failed:", err);
        } finally {
          // Bounded-job mode (GitHub Actions, 2026-08-25): the process used
          // to just keep running until killed. Now the trading day has a
          // real end — disconnect cleanly and exit so the job finishes on
          // its own instead of running until the runner's timeout.
          console.log("[eod] trading day complete, shutting down");
          stream.disconnect();
          process.exit(0);
        }
      })();
      return; // shutting down — nothing else to do this tick
    }

    // Only way a hard-stop / breakeven-stop / trailing-stop exit is ever
    // observed — none of those are actions this process initiates, so
    // without this poll, exit_filled would only ever get logged for EOD
    // closes and the trade log (and dailyPnl / the kill switch) would miss
    // every stop-out.
    risk.checkForFills().catch((err) => console.error("[risk] checkForFills failed:", err));
  }, 60_000);

  // Re-rank the top N every hour by re-running the screener in-process
  // (loadOrRunScreener — see its docstring above). A symbol rotating into
  // the top N that wasn't already live-streamed gets dynamically added
  // below: seeded from historical bars, then subscribed on the live MQTT
  // session. CONFIRMED live via testMqttResubscribe.ts (2026-08-19) that
  // re-POSTing /streaming/subscribe with just the new symbol is ADDITIVE —
  // the existing subscription keeps flowing, nothing needs to be resent.
  // (Motivated by a real miss: PSNL crossed over ~30min after it entered
  // the top 2 one day, and the agent — pre-fix — never saw it because it
  // wasn't part of the original startup SYMBOLS.)
  setInterval(() => {
    (async () => {
      const refreshed = await loadOrRunScreener(rest);
      const newActive = topActiveSymbols(refreshed);
      const changed = newActive.size !== activeSymbols.size || [...newActive].some((s) => !activeSymbols.has(s));

      const newlyTracked = [...newActive].filter((s) => !trackedSymbols.has(s));
      for (const symbol of newlyTracked) {
        seedSymbol(rest, signals, symbol)
          .then(() => stream.subscribeSymbols([symbol]))
          .then(() => {
            trackedSymbols.add(symbol);
            console.log(`[watchlist] ${symbol} rotated into the top ${ACTIVE_SYMBOL_COUNT} — now live-tracked`);
          })
          .catch((err) =>
            console.error(`[watchlist] failed to add ${symbol} to the live stream, will retry next hourly check:`, err)
          );
      }

      if (changed) {
        console.log(
          `[watchlist] top ${ACTIVE_SYMBOL_COUNT} changed: [${[...activeSymbols].join(", ")}] -> [${[...newActive].join(", ")}]`
        );
        activeSymbols = newActive;
      } else {
        console.log(`[watchlist] hourly recheck: top ${ACTIVE_SYMBOL_COUNT} unchanged (${[...activeSymbols].join(", ")})`);
      }
    })().catch((err) => console.error("[watchlist] hourly recheck failed:", err));
  }, WATCHLIST_RECHECK_MS);

  console.log("Agent running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
