/**
 * Streaming EMA-9/EMA-20 crossover signal engine.
 * Maintains incremental EMA state per symbol instead of recomputing over the
 * full bar history on every tick — the standard practice for a strategy
 * running on live 1-minute bars.
 */

import { RawBar } from "./barAggregator";

export type Signal = "LONG_ENTRY" | "FLAT" | "NONE";

type PendingDirection = "UP" | "DOWN" | null;

interface SymbolState {
  ema9: number | null;
  ema20: number | null;
  prevEma9: number | null;
  prevEma20: number | null;
  barCount: number;
  // A cross that happened but was too marginal to fire immediately — kept
  // around so a few subsequent bars can confirm it actually turned into a
  // real move. See confirmationWindowBars below.
  pendingDirection: PendingDirection;
  pendingSinceBar: number | null;
}

const K9 = 2 / (9 + 1);
const K20 = 2 / (20 + 1);

export class SignalEngine {
  private state = new Map<string, SymbolState>();

  /**
   * minSeparationPct: a crossover only counts if EMA-9 and EMA-20 are at
   * least this far apart (as a fraction of EMA-20) — filters out marginal,
   * barely-there crossovers, the classic signature of a flat/choppy market
   * whipsawing the strategy in and out. Added 2026-08-20 after a real
   * observed whipsaw (PSNL: stopped out at breakeven, then a fresh
   * crossover fired 4 minutes later on the bounce back through, at a worse
   * price). This is a deliberate deviation from the Script Editor source
   * (see main.ts's Strategy parameters section) — the original strategy
   * has no such filter.
   *
   * confirmationWindowBars: a cross that's too marginal at the moment it
   * happens is no longer just dropped — it's watched for up to this many
   * subsequent bars to see if separation grows past minSeparationPct while
   * EMA-9 stays on the same side of EMA-20 (i.e. the "cross" itself never
   * gets undone by a reversal in between). Added 2026-08-26 after a real
   * missed trend: MSTZ crossed up with only 0.003% separation (correctly
   * filtered as noise in the moment), but the move was real — separation
   * grew past 0.3% just 7 bars later as price ran from $5.87 to $6.08, and
   * the old one-shot-only crossedUp check had no way to ever catch that,
   * since EMA-9 never crosses again while it's already sitting above
   * EMA-20. Without this, a marginal-then-confirmed trend was invisible to
   * the strategy for its entire duration.
   */
  constructor(
    private minSeparationPct: number = 0.003,
    private confirmationWindowBars: number = 10
  ) {}

  private getState(symbol: string): SymbolState {
    if (!this.state.has(symbol)) {
      this.state.set(symbol, {
        ema9: null,
        ema20: null,
        prevEma9: null,
        prevEma20: null,
        barCount: 0,
        pendingDirection: null,
        pendingSinceBar: null,
      });
    }
    return this.state.get(symbol)!;
  }

  /**
   * Feed a new closed bar. Returns a signal if a crossover happened on this
   * bar, OR if a previously-marginal crossover just confirmed itself (see
   * confirmationWindowBars above).
   * NOTE: only fire on bar close, not on every intra-bar tick, or you'll get
   * spurious crossovers from noise before the bar settles.
   */
  onBarClose(symbol: string, bar: RawBar, log: (msg: string) => void = console.log): Signal {
    const s = this.getState(symbol);
    s.prevEma9 = s.ema9;
    s.prevEma20 = s.ema20;

    s.ema9 = s.ema9 === null ? bar.close : bar.close * K9 + s.ema9 * (1 - K9);
    s.ema20 = s.ema20 === null ? bar.close : bar.close * K20 + s.ema20 * (1 - K20);
    s.barCount += 1;

    // Need at least 20 bars of warm-up before trusting the EMA-20 value —
    // seed from historical bars via get_stock_bars before going live on a
    // fresh symbol, or this will fire false signals on cold start.
    if (s.barCount < 20) return "NONE";
    if (s.prevEma9 === null || s.prevEma20 === null) return "NONE";

    const crossedUp = s.prevEma9 <= s.prevEma20 && s.ema9 > s.ema20;
    const crossedDown = s.prevEma9 >= s.prevEma20 && s.ema9 < s.ema20;

    if (crossedUp || crossedDown) {
      // A fresh cross, in either direction, always supersedes whatever was
      // previously pending — that setup is gone regardless of which way it
      // resolved.
      s.pendingDirection = null;
      s.pendingSinceBar = null;

      const separationPct = Math.abs(s.ema9 - s.ema20) / s.ema20;
      if (separationPct < this.minSeparationPct) {
        s.pendingDirection = crossedUp ? "UP" : "DOWN";
        s.pendingSinceBar = s.barCount;
        log(
          `[signal] ${symbol} crossed ${s.pendingDirection} but only ${(separationPct * 100).toFixed(3)}% separation — ` +
            `watching up to ${this.confirmationWindowBars} bars for confirmation instead of firing now`
        );
        return "NONE";
      }

      if (crossedUp) return "LONG_ENTRY";
      return "FLAT"; // exit signal for long-only strategy
    }

    // No fresh cross this bar — check whether a pending one from earlier
    // just confirmed itself (separation grew past the threshold) or expired.
    if (s.pendingDirection !== null && s.pendingSinceBar !== null) {
      const barsSincePending = s.barCount - s.pendingSinceBar;
      if (barsSincePending > this.confirmationWindowBars) {
        log(`[signal] ${symbol} pending ${s.pendingDirection} cross expired after ${barsSincePending} bars without confirming`);
        s.pendingDirection = null;
        s.pendingSinceBar = null;
        return "NONE";
      }

      const separationPct = Math.abs(s.ema9 - s.ema20) / s.ema20;
      if (separationPct >= this.minSeparationPct) {
        log(
          `[signal] ${symbol} pending ${s.pendingDirection} cross confirmed after ${barsSincePending} bars, ` +
            `separation now ${(separationPct * 100).toFixed(3)}%`
        );
        const direction = s.pendingDirection;
        s.pendingDirection = null;
        s.pendingSinceBar = null;
        return direction === "UP" ? "LONG_ENTRY" : "FLAT";
      }
    }

    return "NONE";
  }

  /** Seed EMA state from historical bars so a fresh connection doesn't need a live 20-bar warm-up. */
  seed(symbol: string, historicalCloses: number[]): void {
    const s = this.getState(symbol);
    for (const close of historicalCloses) {
      s.ema9 = s.ema9 === null ? close : close * K9 + s.ema9 * (1 - K9);
      s.ema20 = s.ema20 === null ? close : close * K20 + s.ema20 * (1 - K20);
      s.barCount += 1;
    }
  }
}
