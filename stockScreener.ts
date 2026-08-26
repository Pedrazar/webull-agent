/**
 * Pre-market stock screener — builds the daily watchlist for main.ts.
 *
 * Rules-based, no LLM judgment in symbol selection. Two passes:
 *
 *   1. Cheap filter using Webull's screener endpoints (paths confirmed from
 *      the official Python SDK source, webull/data/request/screener/*.py,
 *      and verified live against api.sandbox.webull.com):
 *        GET /openapi/market-data/screener/gainers-losers (rank_type=PRE_MARKET)
 *        GET /openapi/market-data/screener/top-active      (rank_type=VOLUME)
 *      Filters directly on fields these already return: price, market cap
 *      (market_value), gap % (open vs pre_close), and relative volume
 *      (relative_volume_10d).
 *
 *   2. Enrichment for the smaller surviving set, since float and average
 *      volume aren't in the screener response — confirmed live:
 *        GET  /openapi/market-data/stock/snapshot   (batched via comma-
 *             joined symbols) -> out_standing_shares, used as the float
 *             proxy. Webull doesn't expose a distinct "free float" number
 *             separate from outstanding shares, so this can run a bit high
 *             vs. a data provider that excludes insider/restricted shares.
 *        POST /openapi/market-data/stock/batch-bars  (one call, all
 *             surviving symbols, timespan=D count=10) -> 10-day average
 *             daily volume, matching the 10-day window Webull's own
 *             relative_volume_10d is anchored to.
 *
 * Criteria (per user spec): market cap > $300M, price $1-$20, gap >= 5%,
 * 10-day avg volume > 1M shares, relative volume (10d) > 2, float
 * (outstanding shares) > 20M.
 *
 * ASSUMPTION: "gap" is interpreted as a gap UP (open >= pre_close * 1.05),
 * not absolute gap in either direction — this agent's strategy
 * (EMATrailingStopStrategy / signalEngine.ts) is long-only, so a gap down
 * isn't an actionable setup here. Flag if that's wrong.
 *
 * Run this on its own schedule BEFORE main.ts starts (see the
 * WebullWatchlistScreener scheduled task, ~30min ahead of WebullAgentStart).
 * main.ts only ever reads whatever is already in watchlist.json — it does
 * not screen live itself.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";
import { getValidAccessToken } from "./prodTokenManager";

interface ScreenerRow {
  symbol: string;
  price: string;
  open: string;
  pre_close: string;
  volume: string;
  market_value: string;
  relative_volume_10d?: string;
}

interface ScreenerResponse {
  data: ScreenerRow[];
  has_more: boolean;
}

interface SnapshotRow {
  symbol: string;
  out_standing_shares: string;
}

interface BatchBarsResponse {
  result: Array<{
    symbol: string;
    result: Array<{ volume: string }>;
  }>;
}

const MIN_PRICE = Number(process.env.SCREENER_MIN_PRICE ?? 1);
const MAX_PRICE = Number(process.env.SCREENER_MAX_PRICE ?? 20);
const MIN_MARKET_CAP = Number(process.env.SCREENER_MIN_MARKET_CAP ?? 300_000_000);
const MIN_GAP_PCT = Number(process.env.SCREENER_MIN_GAP_PCT ?? 0.05); // gap UP — see ASSUMPTION above
const MIN_AVG_VOLUME = Number(process.env.SCREENER_MIN_AVG_VOLUME ?? 1_000_000);
const MIN_RELATIVE_VOLUME = Number(process.env.SCREENER_MIN_RELATIVE_VOLUME ?? 2);
const MIN_FLOAT = Number(process.env.SCREENER_MIN_FLOAT ?? 20_000_000);
const WATCHLIST_SIZE = Number(process.env.SCREENER_WATCHLIST_SIZE ?? 5);
const AVG_VOLUME_LOOKBACK_DAYS = 10; // matches Webull's own relative_volume_10d window

const PAGE_SIZE = 100;
const MAX_PAGES = 3; // caps each source at 300 candidates scanned

const WATCHLIST_PATH = path.join(__dirname, "watchlist.json");
const GAP_UP_WATCHLIST_NAME = process.env.SCREENER_PROD_WATCHLIST_NAME ?? "Gap up";

function passesCheapFilter(row: ScreenerRow): boolean {
  const price = parseFloat(row.price);
  const marketCap = parseFloat(row.market_value);
  const open = parseFloat(row.open);
  const preClose = parseFloat(row.pre_close);
  const relVol = row.relative_volume_10d ? parseFloat(row.relative_volume_10d) : NaN;

  if (![price, marketCap, open, preClose].every(Number.isFinite)) return false;
  if (price < MIN_PRICE || price > MAX_PRICE) return false;
  if (marketCap < MIN_MARKET_CAP) return false;
  if (preClose <= 0) return false;

  const gapPct = (open - preClose) / preClose;
  if (gapPct < MIN_GAP_PCT) return false;

  if (!Number.isFinite(relVol) || relVol < MIN_RELATIVE_VOLUME) return false;

  return true;
}

async function fetchAllPages(
  client: WebullClient,
  urlPath: string,
  baseParams: Record<string, string>
): Promise<ScreenerRow[]> {
  const rows: ScreenerRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await client.get<ScreenerResponse>(urlPath, {
      ...baseParams,
      page_index: String(page),
      page_size: String(PAGE_SIZE),
    });
    rows.push(...result.data);
    if (!result.has_more) break;
  }
  return rows;
}

async function fetchFloats(client: WebullClient, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const snapshots = await client.get<SnapshotRow[]>("/openapi/market-data/stock/snapshot", {
    symbols: symbols.join(","),
    category: "US_STOCK",
  });
  const floats = new Map<string, number>();
  for (const s of snapshots) {
    floats.set(s.symbol, parseFloat(s.out_standing_shares));
  }
  return floats;
}

async function fetchAvgVolumes(client: WebullClient, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const response = await client.post<BatchBarsResponse>("/openapi/market-data/stock/batch-bars", {
    symbols,
    category: "US_STOCK",
    timespan: "D",
    count: String(AVG_VOLUME_LOOKBACK_DAYS),
  });
  const avgVolumes = new Map<string, number>();
  for (const entry of response.result) {
    const volumes = entry.result.map((bar) => parseFloat(bar.volume)).filter(Number.isFinite);
    if (volumes.length === 0) continue;
    avgVolumes.set(entry.symbol, volumes.reduce((a, b) => a + b, 0) / volumes.length);
  }
  return avgVolumes;
}

interface WatchlistRow {
  name: string;
  watchlist_id: string;
}

interface WatchlistInstrument {
  symbol: string;
}

/**
 * Replaces the named real-account watchlist's contents with exactly
 * today's picks — confirmed live: list/add/remove all use { watchlist_id,
 * instruments: [{ symbol, category, sort? }] }. This is production
 * account data, separate from all the sandbox calls above; trading/orders
 * never use this client or token.
 *
 * Uses production credentials + the CONFIRMED create/check/refresh token
 * flow in prodTokenManager.ts — a brand-new token requires the account
 * holder to approve it inside the real Webull app, which can't happen
 * unattended, so any failure here is caught by the caller and just skips
 * the push rather than failing the whole screener run (watchlist.json,
 * which main.ts actually depends on to trade, is written from sandbox
 * data regardless of whether this succeeds).
 */
async function pushToGapUpWatchlist(symbols: string[]): Promise<void> {
  const prodBaseUrl = process.env.WEBULL_PROD_BASE_URL ?? "https://api.webull.com";
  const prodAppKey = process.env.WEBULL_PROD_APP_KEY;
  const prodAppSecret = process.env.WEBULL_PROD_APP_SECRET;

  if (!prodAppKey || !prodAppSecret) {
    console.log("[screener] WEBULL_PROD_APP_KEY/SECRET not set, skipping Gap up watchlist push");
    return;
  }

  const prod = new WebullClient({
    appKey: prodAppKey,
    appSecret: prodAppSecret,
    baseUrl: prodBaseUrl,
    host: new URL(prodBaseUrl).host,
  });

  const accessToken = await getValidAccessToken(prod);
  prod.setAccessToken(accessToken);

  const watchlists = await prod.get<WatchlistRow[]>("/openapi/market-data/watchlist/list");
  const target = watchlists.find((w) => w.name === GAP_UP_WATCHLIST_NAME);
  if (!target) {
    console.warn(
      `[screener] no watchlist named "${GAP_UP_WATCHLIST_NAME}" found in the production account, skipping push`
    );
    return;
  }

  const current = await prod.get<{ instruments: WatchlistInstrument[] }>(
    "/openapi/market-data/watchlist/instruments/list",
    { watchlist_id: target.watchlist_id }
  );
  const currentSymbols = new Set(current.instruments.map((i) => i.symbol));
  const desiredSymbols = new Set(symbols);

  const toRemove = current.instruments.filter((i) => !desiredSymbols.has(i.symbol));
  const toAdd = symbols.filter((s) => !currentSymbols.has(s));

  if (toRemove.length > 0) {
    await prod.post("/openapi/market-data/watchlist/instruments/remove", {
      watchlist_id: target.watchlist_id,
      instruments: toRemove.map((i) => ({ symbol: i.symbol, category: "US_STOCK" })),
    });
  }
  if (toAdd.length > 0) {
    await prod.post("/openapi/market-data/watchlist/instruments/add", {
      watchlist_id: target.watchlist_id,
      instruments: toAdd.map((symbol, i) => ({ symbol, category: "US_STOCK", sort: i + 1 })),
    });
  }

  console.log(
    `[screener] "${GAP_UP_WATCHLIST_NAME}" watchlist updated: +${toAdd.length} -${toRemove.length}, ` +
      `now matches today's picks exactly`
  );
}

/**
 * Runs both filter passes, writes watchlist.json, and (best-effort) pushes
 * to the real "Gap up" watchlist. Returns the picked symbols (empty array
 * if nothing survived either pass) so callers running in-process (main.ts,
 * on startup and its hourly recheck) can use the result directly instead of
 * relying on a separate scheduled process having already written the file.
 * Accepts an optional pre-built client so a caller that already has one
 * (main.ts) doesn't need to construct a second one every hourly call.
 */
export async function runScreener(client?: WebullClient): Promise<string[]> {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const rest =
    client ??
    new WebullClient({
      appKey: process.env.WEBULL_APP_KEY!,
      appSecret: process.env.WEBULL_APP_SECRET!,
      baseUrl,
      host: new URL(baseUrl).host,
    });

  console.log(
    `[screener] pass 1: price $${MIN_PRICE}-$${MAX_PRICE}, market cap > $${MIN_MARKET_CAP.toLocaleString()}, ` +
      `gap >= ${(MIN_GAP_PCT * 100).toFixed(0)}%, relative volume > ${MIN_RELATIVE_VOLUME}`
  );

  const [gainers, mostActive] = await Promise.all([
    fetchAllPages(rest, "/openapi/market-data/screener/gainers-losers", {
      category: "US_STOCK",
      rank_type: "PRE_MARKET",
      sort_by: "CHANGE_RATIO",
      direction: "DESC",
    }),
    fetchAllPages(rest, "/openapi/market-data/screener/top-active", {
      category: "US_STOCK",
      rank_type: "VOLUME",
      sort_by: "VOLUME",
      direction: "DESC",
    }),
  ]);

  const bySymbol = new Map<string, ScreenerRow>();
  for (const row of [...gainers, ...mostActive]) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
  }

  const cheapSurvivors = [...bySymbol.values()].filter(passesCheapFilter);
  console.log(`[screener] pass 1: ${cheapSurvivors.length} of ${bySymbol.size} candidates survived`);

  if (cheapSurvivors.length === 0) {
    console.warn("[screener] no candidates passed pass 1 — leaving existing watchlist.json untouched");
    return [];
  }

  const symbols = cheapSurvivors.map((c) => c.symbol);
  console.log(
    `[screener] pass 2: enriching ${symbols.length} survivors with float (snapshot) + ` +
      `${AVG_VOLUME_LOOKBACK_DAYS}-day avg volume (batch-bars) — min avg volume ${MIN_AVG_VOLUME.toLocaleString()}, ` +
      `min float ${MIN_FLOAT.toLocaleString()}`
  );

  const [floats, avgVolumes] = await Promise.all([
    fetchFloats(rest, symbols),
    fetchAvgVolumes(rest, symbols),
  ]);

  const final = cheapSurvivors.filter((c) => {
    const float = floats.get(c.symbol);
    const avgVolume = avgVolumes.get(c.symbol);
    return float !== undefined && float > MIN_FLOAT && avgVolume !== undefined && avgVolume > MIN_AVG_VOLUME;
  });

  final.sort((a, b) => parseFloat(b.relative_volume_10d ?? "0") - parseFloat(a.relative_volume_10d ?? "0"));

  const picked = final.slice(0, WATCHLIST_SIZE);

  if (picked.length === 0) {
    console.warn("[screener] no candidates passed pass 2 (float/avg volume) — leaving existing watchlist.json untouched");
    return [];
  }

  fs.writeFileSync(
    WATCHLIST_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), symbols: picked.map((c) => c.symbol) },
      null,
      2
    )
  );

  console.log(`[screener] wrote ${picked.length} symbols to watchlist.json:`);
  for (const c of picked) {
    const gapPct = (parseFloat(c.open) - parseFloat(c.pre_close)) / parseFloat(c.pre_close);
    console.log(
      `  ${c.symbol}: price=${c.price} cap=$${(parseFloat(c.market_value) / 1e6).toFixed(0)}M ` +
        `gap=${(gapPct * 100).toFixed(1)}% relVol=${c.relative_volume_10d} ` +
        `avgVol=${(avgVolumes.get(c.symbol)! / 1e6).toFixed(2)}M float=${(floats.get(c.symbol)! / 1e6).toFixed(0)}M`
    );
  }

  // Never let a production auth/network hiccup break the sandbox-based
  // watchlist.json above — that's the file main.ts actually trades off of.
  try {
    await pushToGapUpWatchlist(picked.map((c) => c.symbol));
  } catch (err) {
    console.error("[screener] Gap up watchlist push failed, watchlist.json is unaffected:", err);
  }

  return picked.map((c) => c.symbol);
}

// CLI entry point — `npx tsx stockScreener.ts` still works standalone,
// unchanged from before runScreener() was extracted for main.ts's reuse.
if (require.main === module) {
  runScreener().catch((err) => {
    console.error("[screener] fatal:", err);
    process.exit(1);
  });
}
