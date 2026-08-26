/**
 * Aggregates live trade ticks into 1-minute OHLC bars for the EMA signal
 * engine.
 *
 * Uses TICK data (actual executed trade price/size) rather than QUOTE
 * (bid/ask snapshots) — confirmed via live side-by-side testing that TICK
 * gives the real last-traded price your backtested strategy was tuned
 * against, while QUOTE only gives bid/ask with no trade price at all.
 * QUOTE updates far more frequently, but frequency isn't what a bar-close
 * strategy needs — trade-price accuracy is.
 */

import { DecodedTick } from "./marketDataStream";

export interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InProgressBar {
  minuteEpoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class BarAggregator {
  private inProgress = new Map<string, InProgressBar>();

  constructor(private onBarClose: (symbol: string, bar: RawBar) => void) {}

  onTick(tick: DecodedTick): void {
    if (!tick.price) return;
    const minuteEpoch = Math.floor(tick.timestampMs / 60_000) * 60_000;
    const current = this.inProgress.get(tick.symbol);

    if (!current) {
      this.inProgress.set(tick.symbol, {
        minuteEpoch,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size,
      });
      return;
    }

    if (minuteEpoch > current.minuteEpoch) {
      this.onBarClose(tick.symbol, {
        time: current.minuteEpoch,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        volume: current.volume,
      });

      this.inProgress.set(tick.symbol, {
        minuteEpoch,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size,
      });
      return;
    }

    current.high = Math.max(current.high, tick.price);
    current.low = Math.min(current.low, tick.price);
    current.close = tick.price;
    current.volume += tick.size;
  }
}
