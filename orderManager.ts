/**
 * Risk & order management layer. Wraps raw order placement with the
 * hard-stop -> breakeven -> trailing-stop state machine, and a kill switch.
 *
 * FULLY VERIFIED — every core operation confirmed live against
 * api.sandbox.webull.com with real server responses:
 *   - POST /openapi/trade/stock/order/preview
 *   - POST /openapi/trade/stock/order/place
 *   - POST /openapi/trade/stock/order/cancel   { account_id, client_order_id }
 *   - POST /openapi/trade/stock/order/replace  { account_id, modify_orders: [{ client_order_id, ...changed fields }] }
 *   - GET  /openapi/assets/positions?account_id=...  -> array of
 *     { symbol, quantity, cost_price, last_price, market_value,
 *       unrealized_profit_loss, position_id, instrument_type, ... } (all
 *     numeric fields are strings, per the pattern seen everywhere else in
 *     this API)
 *   - GET  /openapi/trade/order/open?account_id=...  -> array of open
 *     orders with client_order_id, order_id, order_type, symbol, side, etc.
 *
 *   Both cancel and replace key off client_order_id, NOT the order_id the
 *   place call also returns — confirmed empirically, not just by docs.
 *
 *   Cancel confirmed to have a real timing race: cancelling immediately
 *   after placement can fail with
 *   OAUTH_OPENAPI_ORDER_CAN_NOT_BE_CANCEL_FOR_PENDING_SUBMIT — the order
 *   needs a moment to settle broker-side first. Handled below with
 *   retry-with-backoff.
 *
 *   Preview/place/replace all use the same body shape for order objects:
 *   { client_order_id, symbol, market, instrument_type: "EQUITY", side,
 *     order_type, quantity, time_in_force, entrust_type: "QTY",
 *     support_trading_session, combo_type: "NORMAL" } — replace only needs
 *   client_order_id plus whichever fields are actually changing.
 *
 *   support_trading_session valid values (confirmed): "CORE" (regular hours),
 *   "NIGHT" (overnight session), "ALL" (extended hours, per official docs
 *   example — not yet live-tested by us directly, but documented).
 *
 * ❌ STILL UNVERIFIED — the OTOCO/bracket combo order shape (entry +
 *     stop-loss as one submission) is untested; this file still uses the
 *     safer two-call (entry then stop) approach instead, which is now FULLY
 *     verified end-to-end. The combo/bracket approach is an optional future
 *     optimization, not a blocker — every operation this file actually uses
 *     has been confirmed live in the sandbox.
 *
 * ❌ TRAILING_STOP_LOSS order type — tried, confirmed NOT to work as of
 *     2026-08-20: the order places and rests fine, but its stop_price does
 *     not actually move as price rises (MRVI ran from 8.27 to a 8.34 peak
 *     over 20+ minutes while its broker-reported trailing stop sat frozen
 *     at its initial 8.12, and only ever filled on the way back down at
 *     that original level). Do not reintroduce this order type for
 *     trailing without re-verifying it live first. Trailing is instead
 *     implemented client-side: startTrailing()/ratchetTrailingStop() place
 *     a plain STOP_LOSS and move it up themselves via order/replace,
 *     tracking OpenPosition.highestPrice/stopPrice to know when a move is
 *     actually warranted.
 *
 * ⚠️ RECONCILIATION CAVEAT — reconcile() below rebuilds in-memory position
 *     state from the real broker positions + open orders endpoints, so a
 *     restart doesn't think it's flat when it's actually holding shares.
 *     It CANNOT recover the true original hard-stop distance or phase
 *     history (breakeven already hit? already trailing?) — that state
 *     lived only in memory and is genuinely gone after a crash. It makes a
 *     conservative best guess (see reconcile() comments) rather than
 *     pretending to know things it doesn't. Review reconciled positions
 *     manually after any real restart before trusting the agent
 *     unattended again.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { WebullClient } from "./webullClient";
import crypto from "crypto";
import { logTradeEvent } from "./tradeLogger";
import { CooldownInfo } from "./cooldown";

export interface RiskConfig {
  accountId: string;
  // Fixed dollar amounts, matching the Webull Script Editor strategy
  // (EMATrailingStopStrategy) exactly — that strategy uses flat $ amounts,
  // not a percentage or R-multiple of price, so these must too.
  hardStopAmount: number; // e.g. 0.15 = stop placed $0.15 below entry
  breakevenActivationAmount: number; // e.g. 0.20 = move to breakeven once price is $0.20 above entry
  trailingActivationAmount: number; // e.g. 0.30 = arm trailing once price is $0.30 above entry
  trailingStopAmount: number; // e.g. 0.15 = trail distance once trailing is active
  quantity: number; // shares per entry
  minPrice: number; // only enter if price >= this (e.g. 1)
  maxPrice: number; // only enter if price <= this (e.g. 20)
  maxSpread: number; // only enter if (ask - bid) < this, e.g. 0.03 — a wide spread on a low-priced stock eats the edge instantly on entry+exit
  minEntryVolume: number; // only enter if the triggering bar's volume >= this — filters thin/low-participation signal bars
  maxDailyLossUsd: number; // kill switch
  // (EOD timing itself is now handled in main.ts via Intl/America-New_York,
  // not here — these fields are unused, kept only to avoid a breaking
  // config-shape change. closeAllEndOfDay() below just closes on demand.)
}

type PositionPhase = "NONE" | "HARD_STOP" | "BREAKEVEN" | "TRAILING";

interface OpenPosition {
  symbol: string;
  entryPrice: number;
  entryTime: number; // epoch ms, for holdMinutes in trade log
  quantity: number;
  entryOrderId: string;
  stopOrderId: string | null; // the broker's order_id — for display/logging only
  stopClientOrderId: string | null; // REQUIRED for cancel/replace — order_id does NOT work there
  phase: PositionPhase;
  highestPrice: number; // high-water mark since entry — drives the client-side trailing ratchet below
  stopPrice: number | null; // the price currently resting on the broker's stop order, so the ratchet only replaces when it actually needs to move up
}

interface OrderDetailResponse {
  orders: Array<{
    status: string;
    filled_quantity: string;
    filled_price?: string;
  }>;
}

/** Maps the internal phase to the trade-log's exit-reason vocabulary. */
function exitReasonForPhase(phase: PositionPhase): "HARD_STOP" | "BREAKEVEN" | "TRAILING" {
  return phase === "TRAILING" ? "TRAILING" : phase === "BREAKEVEN" ? "BREAKEVEN" : "HARD_STOP";
}

/** Fields common to every simple order — confirmed shape, from live testing. */
function baseOrderFields(overrides: Record<string, unknown>) {
  return {
    entrust_type: "QTY",
    support_trading_session: "CORE",
    combo_type: "NORMAL",
    instrument_type: "EQUITY",
    market: "US",
    ...overrides,
  };
}

function newClientOrderId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export class OrderManager {
  private positions = new Map<string, OpenPosition>();
  private dailyPnl = 0;
  private killSwitchTripped = false;
  private volumeSource: Map<string, number> | null = null;
  private cooldownSymbols = new Map<string, CooldownInfo>();

  constructor(private client: WebullClient, private config: RiskConfig) {}

  /**
   * Wires in main.ts's latestBarVolume map (by reference — it keeps
   * updating on every bar close, this just reads whatever it currently
   * holds). Entries have a bar of their own to read volume from directly;
   * exits are detected by polling order status independently of bar
   * closes, so this is how they get "most recent known volume as of the
   * fill" instead. Added 2026-08-21 for the daily review's volume-at-entry
   * /exit reporting.
   */
  setVolumeSource(volumeSource: Map<string, number>): void {
    this.volumeSource = volumeSource;
  }

  /**
   * Symbols computed at startup (see cooldown.ts) as having just lost N
   * times in a row — new entries on them are refused until the cooldown
   * expires. Added 2026-09-01: the one piece of the agent that adapts
   * based on trade outcomes, deliberately scoped to counting a losing
   * streak rather than inferring correlations from a small sample.
   */
  setCooldownSymbols(cooldownSymbols: Map<string, CooldownInfo>): void {
    this.cooldownSymbols = cooldownSymbols;
  }

  private latestVolume(symbol: string): number | null {
    return this.volumeSource?.get(symbol) ?? null;
  }

  /**
   * Rebuilds in-memory position state from the real broker on startup —
   * CONFIRMED endpoints:
   *   GET /openapi/assets/positions?account_id=...
   *   GET /openapi/trade/order/open?account_id=...
   *
   * Honest limitation: this can recover WHAT you hold (symbol, quantity,
   * cost basis) and WHETHER an open stop/trailing order exists for it, but
   * it cannot recover the true original phase history — that lived only in
   * the previous process's memory. Conservative approach taken here:
   *   - phase is set to HARD_STOP unless an open order for that symbol is
   *     found with order_type TRAILING_STOP_LOSS (-> TRAILING) — there's no
   *     way to distinguish "still at hard stop" from "was at breakeven" from
   *     the position/order data alone, so this defaults to the safer
   *     (more conservative) assumption.
   *
   * Returns the symbols it found open positions for — callers MUST make
   * sure these end up in the live MQTT subscription and get EMA-seeded
   * even if they've since dropped out of today's watchlist, or the agent
   * will hold a real position with zero price visibility into it (no
   * bars, so no breakeven/trailing management ever runs, even though the
   * stop order itself keeps resting fine at the broker). Discovered live
   * on 2026-08-20: a restart right after the watchlist rotated to a new
   * top symbol left an existing PSNL position exactly in this state.
   */
  async reconcile(): Promise<string[]> {
    interface PositionResponse {
      symbol: string;
      quantity: string;
      cost_price: string;
      instrument_type: string;
    }
    interface OpenOrderResponse {
      client_order_id: string;
      combo_order_id: string;
      orders: Array<{
        symbol: string;
        order_type: string;
        order_id: string;
        client_order_id: string;
        side: string;
        stop_price?: string;
      }>;
    }

    const positions = await this.client.get<PositionResponse[]>(
      "/openapi/assets/positions",
      { account_id: this.config.accountId }
    );
    const openOrders = await this.client.get<OpenOrderResponse[]>(
      "/openapi/trade/order/open",
      { account_id: this.config.accountId }
    );

    for (const pos of positions) {
      if (pos.instrument_type !== "EQUITY") continue; // this agent only trades equities
      const quantity = parseFloat(pos.quantity);
      const costPrice = parseFloat(pos.cost_price);
      if (quantity <= 0) continue;

      // Find any open SELL order for this symbol — treat it as the tracked stop
      let stopClientOrderId: string | null = null;
      let stopOrderId: string | null = null;
      let stopPrice: number | null = null;
      let phase: PositionPhase = "HARD_STOP";

      for (const combo of openOrders) {
        for (const order of combo.orders) {
          if (order.symbol !== pos.symbol || order.side !== "SELL") continue;
          stopClientOrderId = order.client_order_id;
          stopOrderId = order.order_id;
          stopPrice = order.stop_price ? parseFloat(order.stop_price) : null;
          if (order.order_type === "TRAILING_STOP_LOSS") {
            // Legacy from before 2026-08-20's client-side trailing rework —
            // a broker TRAILING_STOP_LOSS order might still be resting from
            // an in-flight position across a restart. Treat it the same as
            // any other tracked stop; the ratchet only ever replaces it
            // with a plain STOP_LOSS going forward once it needs to move.
            phase = "TRAILING";
          }
        }
      }

      // highestPrice is genuinely unrecoverable across a restart (see
      // caveat above) — best guess is the higher of cost basis and
      // whatever the current resting stop implies (stopPrice +
      // trailingStopAmount), so the ratchet never accidentally LOWERS an
      // already-trailing stop right after a restart.
      const highestPrice =
        stopPrice !== null ? Math.max(costPrice, stopPrice + this.config.trailingStopAmount) : costPrice;

      this.positions.set(pos.symbol, {
        symbol: pos.symbol,
        entryPrice: costPrice,
        entryTime: Date.now(), // genuinely unrecoverable (see caveat above) — holdMinutes on this position's eventual exit_filled log will undercount
        quantity,
        entryOrderId: "", // genuinely unrecoverable — not returned by the positions endpoint
        stopOrderId,
        stopClientOrderId,
        phase,
        highestPrice,
        stopPrice,
      });

      console.log(
        `[risk] reconciled ${pos.symbol}: qty=${quantity} cost=${costPrice} ` +
          `phase=${phase} stopTracked=${stopClientOrderId !== null}`
      );
    }

    if (positions.length === 0) {
      console.log("[risk] reconcile: no open equity positions found, starting flat");
    }

    return [...this.positions.keys()];
  }

  killSwitchActive(): boolean {
    return this.killSwitchTripped || this.dailyPnl <= -this.config.maxDailyLossUsd;
  }

  /**
   * Polls GET /openapi/trade/order/detail (CONFIRMED shape live: { orders:
   * [{ status, filled_quantity, filled_price, ... }] }, same underlying
   * data as order/history) until the order reaches a terminal state or
   * attempts run out. Used both to confirm the entry fill price (rather
   * than trusting the bar-close price the signal fired on, which can differ
   * from the actual fill) and to detect stop/trailing-stop fills that
   * happen with no action from this process at all.
   *
   * Returns null if the order hasn't settled within maxAttempts — callers
   * must treat that as "still unknown," not as "not filled."
   */
  private async pollOrderFill(
    clientOrderId: string,
    maxAttempts = 5,
    delayMs = 1000
  ): Promise<{ status: string; filledPrice: number | null; filledQuantity: number } | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const detail = await this.client.get<OrderDetailResponse>("/openapi/trade/order/detail", {
        account_id: this.config.accountId,
        client_order_id: clientOrderId,
      });
      const order = detail.orders?.[0];
      if (order && (order.status === "FILLED" || order.status === "CANCELLED" || order.status === "REJECTED")) {
        return {
          status: order.status,
          filledPrice: order.filled_price ? parseFloat(order.filled_price) : null,
          filledQuantity: parseFloat(order.filled_quantity ?? "0"),
        };
      }
      if (attempt < maxAttempts) await sleep(delayMs);
    }
    return null;
  }

  /**
   * Call periodically (main.ts does this every minute) for every open
   * position: checks whether its currently-active stop/trailing-stop order
   * has filled at the broker WITHOUT this process having placed a closing
   * order itself — the only way a hard-stop, breakeven-stop, or trailing
   * stop exit is ever observed, since none of those are actions this
   * process initiates. Logs exit_filled with realized P&L and updates
   * dailyPnl, which is what actually makes killSwitchActive()'s daily-loss
   * check live (it was dead code before — dailyPnl was never written to).
   */
  async checkForFills(): Promise<void> {
    for (const pos of [...this.positions.values()]) {
      if (!pos.stopClientOrderId) continue;
      const result = await this.pollOrderFill(pos.stopClientOrderId, 1, 0); // single check, no wait — this is a poll, not a blocking wait for a fill we just triggered
      if (!result || result.status !== "FILLED") continue;

      const exitPrice = result.filledPrice ?? pos.entryPrice;
      const quantity = result.filledQuantity || pos.quantity;
      const realizedPnl = (exitPrice - pos.entryPrice) * quantity;
      const holdMinutes = Math.round((Date.now() - pos.entryTime) / 60_000);

      this.dailyPnl += realizedPnl;
      logTradeEvent({
        event: "exit_filled",
        symbol: pos.symbol,
        exitReason: exitReasonForPhase(pos.phase),
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity,
        realizedPnl,
        holdMinutes,
        volume: this.latestVolume(pos.symbol),
      });
      this.positions.delete(pos.symbol);
    }
  }

  /**
   * Places a plain market entry using the CONFIRMED simple-order shape
   * (verified live against /openapi/trade/stock/order/place), then a
   * SEPARATE stop order right after. Two round-trips instead of one atomic
   * bracket — the OCO/OTOCO combo shape is documented but not yet
   * live-tested by us, so this safer two-call approach is used until that's
   * confirmed too.
   */
  async enterLong(symbol: string, price: number, spread: number | null): Promise<void> {
    if (this.killSwitchActive()) {
      console.warn(`[risk] kill switch active, refusing entry on ${symbol}`);
      logTradeEvent({ event: "entry_rejected", symbol, reason: "kill_switch_active", price });
      return;
    }
    if (this.positions.has(symbol)) return; // already in a position, not logged as a rejection — this is routine, not a decision

    const cooldown = this.cooldownSymbols.get(symbol);
    if (cooldown) {
      console.warn(`[risk] ${symbol} on cooldown until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
      logTradeEvent({ event: "entry_rejected", symbol, reason: "symbol_on_cooldown", price, cooldownReason: cooldown.reason });
      return;
    }

    if (price < this.config.minPrice || price > this.config.maxPrice) {
      console.log(
        `[risk] ${symbol} @ ${price} outside allowed price range ` +
          `[${this.config.minPrice}, ${this.config.maxPrice}], skipping entry`
      );
      logTradeEvent({ event: "entry_rejected", symbol, reason: "price_out_of_range", price });
      return;
    }

    if (spread === null) {
      console.log(`[risk] ${symbol} @ ${price} has no live quote yet, skipping entry (can't verify spread)`);
      logTradeEvent({ event: "entry_rejected", symbol, reason: "quote_unavailable", price, spread: null });
      return;
    }

    if (spread >= this.config.maxSpread) {
      console.log(
        `[risk] ${symbol} @ ${price} spread ${spread.toFixed(2)} >= max ${this.config.maxSpread}, skipping entry`
      );
      logTradeEvent({ event: "entry_rejected", symbol, reason: "spread_too_wide", price, spread });
      return;
    }

    // Signal-bar volume floor — added 2026-09-03 after a real SID entry
    // fired on a 100-share signal bar (two to three orders of magnitude
    // thinner than every other entry that day), a low-participation/
    // possibly-stale-tick situation the daily review flagged as exactly
    // what this field exists to catch. Fails closed like the spread check
    // above: missing volume blocks the entry rather than allowing it.
    const volume = this.latestVolume(symbol);
    if (volume === null || volume < this.config.minEntryVolume) {
      console.log(
        `[risk] ${symbol} @ ${price} signal-bar volume ${volume ?? "unavailable"} < min ${this.config.minEntryVolume}, skipping entry`
      );
      logTradeEvent({ event: "entry_rejected", symbol, reason: "volume_too_low", price, volume });
      return;
    }

    const quantity = this.config.quantity;
    const entryClientOrderId = newClientOrderId();

    const entryOrder = baseOrderFields({
      client_order_id: entryClientOrderId,
      symbol,
      side: "BUY",
      order_type: "MARKET",
      quantity: String(quantity),
      time_in_force: "DAY",
    });

    const entryResult = await this.client.post<{
      order_id?: string;
      client_order_id?: string;
      [key: string]: unknown;
    }>("/openapi/trade/stock/order/place", {
      account_id: this.config.accountId,
      new_orders: [entryOrder],
    });

    // Poll for the actual fill price rather than trusting the bar-close
    // price the signal fired on — a MARKET order can slip from that price,
    // and the stop distance (and the trade log) should be anchored to what
    // was actually paid, not the intended price.
    const fill = await this.pollOrderFill(entryClientOrderId);
    const entryPrice = fill?.filledPrice ?? price;
    if (!fill || fill.status !== "FILLED") {
      console.warn(
        `[risk] entry fill for ${symbol} not confirmed within poll window, ` +
          `falling back to signal price ${price} for stop placement`
      );
    }

    const stopPrice = +(entryPrice - this.config.hardStopAmount).toFixed(2);
    const stopClientOrderId = newClientOrderId();
    const stopOrder = baseOrderFields({
      client_order_id: stopClientOrderId,
      symbol,
      side: "SELL",
      order_type: "STOP_LOSS",
      stop_price: String(stopPrice),
      quantity: String(quantity),
      time_in_force: "GTC",
    });

    const stopResult = await this.client.post<{
      order_id?: string;
      client_order_id?: string;
      [key: string]: unknown;
    }>("/openapi/trade/stock/order/place", {
      account_id: this.config.accountId,
      new_orders: [stopOrder],
    });

    const entryOrderId = (entryResult.order_id as string) ?? null;
    const stopOrderId = (stopResult.order_id as string) ?? null;

    this.positions.set(symbol, {
      symbol,
      entryPrice,
      entryTime: Date.now(),
      quantity,
      entryOrderId: entryOrderId ?? "",
      stopOrderId,
      stopClientOrderId,
      phase: "HARD_STOP",
      highestPrice: entryPrice,
      stopPrice,
    });

    logTradeEvent({
      event: "entry_placed",
      symbol,
      quantity,
      requestedPrice: price,
      filledPrice: fill?.filledPrice ?? null,
      entryOrderId,
      entryClientOrderId,
      stopPrice,
      stopOrderId,
      stopClientOrderId,
      volume: this.latestVolume(symbol),
    });
  }

  /**
   * Call on every new bar close for symbols with open positions. Handles the
   * breakeven and trailing transitions. This does NOT use price polling for
   * the hard stop itself — that lives as a real stop order at the broker so
   * it fires even if this process is down. Polling here only manages phase
   * transitions, which is a much lower-stakes failure mode.
   *
   * Takes the bar HIGH, not the close — matches the Script Editor strategy,
   * which arms breakeven/trailing off `bar.high` so a wick that touches the
   * trigger and closes back down still counts. Using close here would make
   * this agent trigger later (and sometimes never) versus the backtest.
   *
   * The two checks below are independent ifs, not if/else-if, matching the
   * script: a single bar that gaps through both the breakeven AND trailing
   * triggers should arm trailing immediately, not wait a bar behind.
   */
  async onPriceUpdate(symbol: string, currentHigh: number): Promise<void> {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    pos.highestPrice = Math.max(pos.highestPrice, currentHigh);

    if (
      pos.phase === "HARD_STOP" &&
      currentHigh >= pos.entryPrice + this.config.breakevenActivationAmount
    ) {
      await this.moveStopToBreakeven(pos);
      pos.phase = "BREAKEVEN";
    }

    if (
      pos.phase !== "TRAILING" &&
      currentHigh >= pos.entryPrice + this.config.trailingActivationAmount
    ) {
      await this.startTrailing(pos);
      pos.phase = "TRAILING";
    }

    // Client-side ratchet, not broker-native trailing — CONFIRMED live on
    // 2026-08-20 that a Webull TRAILING_STOP_LOSS order's stop_price does
    // NOT actually move as price rises (MRVI ran from 8.27 to a 8.34 peak
    // over ~20+ minutes while its broker-reported trailing stop sat frozen
    // at its initial 8.12, only ever getting hit on the way back down at
    // the ORIGINAL level rather than a properly trailed one — a real,
    // quantifiable missed exit). So this manages the ratchet itself via
    // order/replace on every bar once in TRAILING phase, the same proven
    // mechanism moveStopToBreakeven already uses.
    if (pos.phase === "TRAILING") {
      await this.ratchetTrailingStop(pos);
    }
  }

  /**
   * VERIFIED — confirmed live against api.sandbox.webull.com. Uses the same
   * modify_orders array pattern as place's new_orders, keyed by
   * client_order_id (not order_id, consistent with cancel).
   */
  private async moveStopToBreakeven(pos: OpenPosition): Promise<void> {
    if (!pos.stopClientOrderId) {
      console.warn(`[risk] no stop order tracked for ${pos.symbol}, skipping breakeven move`);
      return;
    }
    await this.client.post(`/openapi/trade/stock/order/replace`, {
      account_id: this.config.accountId,
      modify_orders: [
        {
          client_order_id: pos.stopClientOrderId,
          stop_price: String(pos.entryPrice),
        },
      ],
    });

    pos.stopPrice = pos.entryPrice;
    logTradeEvent({ event: "breakeven_move", symbol: pos.symbol, newStopPrice: pos.entryPrice });
  }

  /**
   * Cancel uses the CONFIRMED shape: { account_id, client_order_id } — NOT
   * order_id, which looks plausible but is silently wrong (targets nothing).
   * Includes retry-with-backoff for a real race condition confirmed live:
   * cancelling immediately after placement can fail with
   * OAUTH_OPENAPI_ORDER_CAN_NOT_BE_CANCEL_FOR_PENDING_SUBMIT because the
   * order needs a moment to finish settling into an open/working state.
   */
  private async cancelOrderWithRetry(
    clientOrderId: string,
    maxAttempts = 3,
    delayMs = 2000
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.client.post("/openapi/trade/stock/order/cancel", {
          account_id: this.config.accountId,
          client_order_id: clientOrderId,
        });
        return;
      } catch (err) {
        const isPendingSubmit =
          err instanceof Error &&
          err.message.includes("OAUTH_OPENAPI_ORDER_CAN_NOT_BE_CANCEL_FOR_PENDING_SUBMIT");
        if (isPendingSubmit && attempt < maxAttempts) {
          console.log(`[risk] cancel hit pending-submit race, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Cancels pos's currently-tracked stop and confirms it actually reached a
   * terminal state before returning — closes the same cancel/place race
   * fixed in closeOneEndOfDay (cancel returns success, but the shares
   * aren't released back to "available to sell" in time for an immediate
   * follow-up order, which gets rejected as
   * OAUTH_OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION).
   *
   * Also, critically, resilient to being called again after a previous
   * attempt already cancelled the order but then failed to place its
   * replacement: discovered live on 2026-08-20 that the original
   * startTrailing() left pos.stopClientOrderId pointing at the now-dead
   * cancelled order after such a failure, so every subsequent bar's retry
   * re-cancelled the SAME already-gone order forever
   * (OAUTH_OPENAPI_ORDER_CAN_NOT_CANCEL), with no recovery — PSNL sat with
   * zero stop protection for about an hour before this was caught
   * manually. Catching the cancel error (rather than letting it propagate)
   * and always polling for the order's actual terminal status fixes both:
   * a dead order is recognized as already-gone and cleared instead of
   * retried, and a genuine fill is caught and logged instead of silently
   * dropped.
   *
   * Returns false if the order turned out to be FILLED (a real fill raced
   * this call) — the exit is logged here, and callers must treat that as
   * "already flat," not "safe to place a new stop."
   */
  private async cancelStopIfLive(pos: OpenPosition): Promise<boolean> {
    if (!pos.stopClientOrderId) return true;

    try {
      await this.cancelOrderWithRetry(pos.stopClientOrderId);
    } catch {
      // Cancel can fail because the order is already gone (filled, or
      // already cancelled by an earlier attempt at this same transition) —
      // fall through to poll and find out which, instead of treating this
      // as fatal.
    }

    const result = await this.pollOrderFill(pos.stopClientOrderId, 5, 1000);
    if (result?.status === "FILLED") {
      const exitPrice = result.filledPrice ?? pos.entryPrice;
      const quantity = result.filledQuantity || pos.quantity;
      const realizedPnl = (exitPrice - pos.entryPrice) * quantity;
      this.dailyPnl += realizedPnl;
      logTradeEvent({
        event: "exit_filled",
        symbol: pos.symbol,
        exitReason: exitReasonForPhase(pos.phase),
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity,
        realizedPnl,
        holdMinutes: Math.round((Date.now() - pos.entryTime) / 60_000),
        volume: this.latestVolume(pos.symbol),
      });
      this.positions.delete(pos.symbol);
      return false;
    }

    // CANCELLED, or status still unknown after the poll window — either
    // way this order is no longer something a future retry can act on, so
    // clear it now rather than let a doomed cancel repeat forever.
    pos.stopClientOrderId = null;
    pos.stopOrderId = null;
    return true;
  }

  /**
   * Arms trailing: cancels whatever stop is currently resting (breakeven,
   * typically) and places a plain STOP_LOSS at highestPrice -
   * trailingStopAmount. Deliberately NOT a broker TRAILING_STOP_LOSS order
   * — CONFIRMED live on 2026-08-20 that its stop_price does not actually
   * move as price rises (see onPriceUpdate's comment for the incident).
   * ratchetTrailingStop() below is what keeps this moving up from here.
   *
   * Guarantees the position always ends this call with SOME resting
   * protective order (or a logged exit, if the old stop turned out to be
   * FILLED) — never with none. Discovered live on 2026-08-20 that the
   * previous version of this function, on a placement failure, left
   * pos.stopClientOrderId pointing at a dead cancelled order with no
   * fallback — PSNL sat with zero stop protection for about an hour,
   * silently, with every subsequent bar just re-failing the same doomed
   * cancel. This version retries the placement itself on every bar (via
   * onPriceUpdate re-invoking startTrailing while phase is still not
   * TRAILING) rather than giving up after one attempt.
   */
  private async startTrailing(pos: OpenPosition): Promise<void> {
    if (pos.stopClientOrderId) {
      if (!(await this.cancelStopIfLive(pos))) {
        // The old stop turned out to be FILLED, not cancellable — a real
        // fill raced this transition. cancelStopIfLive already logged the
        // exit; nothing left to place.
        return;
      }
    }
    // pos.stopClientOrderId is null here either way: nothing to cancel, or
    // cancelStopIfLive just confirmed the old order is genuinely gone.

    const initialStop = +(pos.highestPrice - this.config.trailingStopAmount).toFixed(2);
    await this.placeStopLossAt(pos, initialStop);

    logTradeEvent({
      event: "trailing_start",
      symbol: pos.symbol,
      trailingStopStep: this.config.trailingStopAmount,
      newStopOrderId: pos.stopOrderId,
      newStopClientOrderId: pos.stopClientOrderId!,
    });
  }

  /**
   * Called every bar once in TRAILING phase. Only acts when highestPrice
   * has moved far enough to actually require raising the stop — most bars
   * are a no-op. Uses order/replace (the same CONFIRMED mechanism as
   * moveStopToBreakeven), not cancel+place, so there's no reverse-position
   * race to worry about here the way there was in startTrailing's old
   * cancel-then-place sequence.
   */
  private async ratchetTrailingStop(pos: OpenPosition): Promise<void> {
    if (!pos.stopClientOrderId || pos.stopPrice === null) return; // nothing resting to ratchet — startTrailing will (re)establish it
    const desiredStop = +(pos.highestPrice - this.config.trailingStopAmount).toFixed(2);
    if (desiredStop <= pos.stopPrice) return; // no new high since the last ratchet

    try {
      await this.client.post("/openapi/trade/stock/order/replace", {
        account_id: this.config.accountId,
        modify_orders: [{ client_order_id: pos.stopClientOrderId, stop_price: String(desiredStop) }],
      });
      pos.stopPrice = desiredStop;
      logTradeEvent({ event: "trailing_move", symbol: pos.symbol, newStopPrice: desiredStop });
    } catch (err) {
      console.error(`[risk] ${pos.symbol}: failed to ratchet trailing stop to ${desiredStop}:`, err);
    }
  }

  private async placeStopLossAt(pos: OpenPosition, stopPrice: number): Promise<void> {
    const clientOrderId = newClientOrderId();
    const order = baseOrderFields({
      client_order_id: clientOrderId,
      symbol: pos.symbol,
      side: "SELL",
      order_type: "STOP_LOSS",
      stop_price: String(stopPrice),
      quantity: String(pos.quantity),
      time_in_force: "GTC",
    });

    const result = await this.client.post<{ order_id?: string }>(
      "/openapi/trade/stock/order/place",
      {
        account_id: this.config.accountId,
        new_orders: [order],
      }
    );
    pos.stopOrderId = (result.order_id as string) ?? null;
    pos.stopClientOrderId = clientOrderId;
    pos.stopPrice = stopPrice;
  }

  /**
   * Force-close at EOD target regardless of signal state.
   *
   * Cancels the tracked stop/trailing-stop order FIRST — without this, the
   * old stop order is left working after the market sell flattens the
   * position, and will error out (or worse, attempt to sell shares that no
   * longer exist) once it's the broker's turn to process it.
   */
  async closeAllEndOfDay(): Promise<void> {
    // Each position's close is independent — a failure on one symbol must
    // not abort the rest of the loop. Discovered live on 2026-08-19: PSNL's
    // close threw (see the race below), which silently skipped MRVI too,
    // since the whole for-of loop lived inside one un-guarded async
    // function and the caller only .catch()es the outer promise.
    for (const pos of [...this.positions.values()]) {
      try {
        await this.closeOneEndOfDay(pos);
      } catch (err) {
        console.error(`[risk] EOD: failed to close ${pos.symbol}, will remain open:`, err);
      }
    }
  }

  private async closeOneEndOfDay(pos: OpenPosition): Promise<void> {
    if (pos.stopClientOrderId) {
      await this.cancelOrderWithRetry(pos.stopClientOrderId);

      // CONFIRMED live 2026-08-19: cancelling the stop and immediately
      // placing the flattening market sell raced the broker's own
      // bookkeeping — the cancel call returned success, but the sell was
      // rejected as OAUTH_OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION
      // ("will reverse an existing position") because the cancelled
      // order's shares hadn't been released back to "available to sell"
      // yet. Poll for the cancel to actually land (or, in the rarer case,
      // for the stop to have filled a beat before we cancelled it) before
      // placing the sell.
      const cancelResult = await this.pollOrderFill(pos.stopClientOrderId, 5, 1000);
      if (cancelResult?.status === "FILLED") {
        // The stop-loss genuinely filled right at EOD, ahead of our
        // cancel — already flat, nothing left to sell.
        const exitPrice = cancelResult.filledPrice ?? pos.entryPrice;
        const quantity = cancelResult.filledQuantity || pos.quantity;
        const realizedPnl = (exitPrice - pos.entryPrice) * quantity;
        this.dailyPnl += realizedPnl;
        logTradeEvent({
          event: "exit_filled",
          symbol: pos.symbol,
          exitReason: exitReasonForPhase(pos.phase),
          entryPrice: pos.entryPrice,
          exitPrice,
          quantity,
          realizedPnl,
          holdMinutes: Math.round((Date.now() - pos.entryTime) / 60_000),
          volume: this.latestVolume(pos.symbol),
        });
        this.positions.delete(pos.symbol);
        return;
      }
      if (cancelResult === null) {
        console.warn(
          `[risk] EOD: cancel for ${pos.symbol}'s stop didn't confirm within the poll window, ` +
            `proceeding with the closing sell anyway`
        );
      }
    }

    const eodClientOrderId = newClientOrderId();
    const eodOrder = baseOrderFields({
      client_order_id: eodClientOrderId,
      symbol: pos.symbol,
      side: "SELL",
      order_type: "MARKET",
      quantity: String(pos.quantity),
      time_in_force: "DAY",
    });

    await this.client.post("/openapi/trade/stock/order/place", {
      account_id: this.config.accountId,
      new_orders: [eodOrder],
    });

    const fill = await this.pollOrderFill(eodClientOrderId);
    const exitPrice = fill?.filledPrice ?? pos.entryPrice;
    const quantity = fill?.filledQuantity || pos.quantity;
    const realizedPnl = (exitPrice - pos.entryPrice) * quantity;
    const holdMinutes = Math.round((Date.now() - pos.entryTime) / 60_000);

    if (!fill || fill.status !== "FILLED") {
      console.warn(
        `[risk] EOD close fill for ${pos.symbol} not confirmed within poll window — ` +
          `logging with entryPrice as a placeholder exitPrice, realizedPnl below is unreliable`
      );
    }

    this.dailyPnl += realizedPnl;
    logTradeEvent({
      event: "exit_filled",
      symbol: pos.symbol,
      exitReason: "EOD",
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity,
      realizedPnl,
      holdMinutes,
      volume: this.latestVolume(pos.symbol),
    });

    this.positions.delete(pos.symbol);
  }
}
