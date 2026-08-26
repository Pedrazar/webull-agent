/**
 * Streaming EMA-9/EMA-20 crossover signal engine.
 * Maintains incremental EMA state per symbol instead of recomputing over the
 * full bar history on every tick — the standard practice for a strategy
 * running on live 1-minute bars.
 */

import { RawBar } from "./barAggregator";

export type Signal = "LONG_ENTRY" | "FLAT" | "NONE";

interface SymbolState {
  ema9: number | null;
  ema20: number | null;
  prevEma9: number | null;
  prevEma20: number | null;
  barCount: number;
}

const K9 = 2 / (9 + 1);
const K20 = 2 / (20 + 1);

export class SignalEngine {
  private state = new Map<string, SymbolState>();

  /**
   * minSeparationPct: a crossover only counts if EMA-9 and EMA-20 are at
   * least this far apart (as a fraction of EMA-20) at the moment they
   * cross — filters out marginal, barely-there crossovers, the classic
   * signature of a flat/choppy market whipsawing the strategy in and out.
   * Added 2026-08-20 after a real observed whipsaw (PSNL: stopped out at
   * breakeven, then a fresh crossover fired 4 minutes later on the bounce
   * back through, at a worse price). This is a deliberate deviation from
   * the Script Editor source (see main.ts's Strategy parameters section)
   * — the original strategy has no such filter.
   */
  constructor(private minSeparationPct: number = 0.003) {}

  private getState(symbol: string): SymbolState {
    if (!this.state.has(symbol)) {
      this.state.set(symbol, {
        ema9: null,
        ema20: null,
        prevEma9: null,
        prevEma20: null,
        barCount: 0,
      });
    }
    return this.state.get(symbol)!;
  }

  /**
   * Feed a new closed bar. Returns a signal if a crossover happened on this bar.
   * NOTE: only fire on bar close, not on every intra-bar tick, or you'll get
   * spurious crossovers from noise before the bar settles.
   */
  onBarClose(symbol: string, bar: RawBar): Signal {
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
      const separationPct = Math.abs(s.ema9 - s.ema20) / s.ema20;
      if (separationPct < this.minSeparationPct) return "NONE"; // too marginal — flat/choppy, not a real trend
    }

    if (crossedUp) return "LONG_ENTRY";
    if (crossedDown) return "FLAT"; // exit signal for long-only strategy
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
