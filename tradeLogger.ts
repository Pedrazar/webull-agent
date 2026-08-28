/**
 * Append-only trade event log — every pertinent order action gets one line
 * in trades.jsonl (one JSON object per line: easy to tail, grep, or parse).
 * This is the raw material the end-of-day review reads; it is never
 * rewritten or truncated by this process, only appended to.
 */

import fs from "fs";
import path from "path";

const LOG_PATH = path.join(__dirname, "trades.jsonl");

export type TradeEvent =
  | {
      event: "entry_placed";
      symbol: string;
      quantity: number;
      requestedPrice: number;
      filledPrice: number | null;
      entryOrderId: string | null;
      entryClientOrderId: string;
      stopPrice: number;
      stopOrderId: string | null;
      stopClientOrderId: string;
      volume: number | null; // volume of the bar that triggered this entry
    }
  | {
      event: "entry_rejected";
      symbol: string;
      reason:
        | "price_out_of_range"
        | "kill_switch_active"
        | "already_in_position"
        | "spread_too_wide"
        | "quote_unavailable";
      price: number;
      spread?: number | null;
    }
  | {
      event: "breakeven_move";
      symbol: string;
      newStopPrice: number;
    }
  | {
      event: "trailing_start";
      symbol: string;
      trailingStopStep: number;
      newStopOrderId: string | null;
      newStopClientOrderId: string;
    }
  | {
      event: "trailing_move";
      symbol: string;
      newStopPrice: number;
    }
  | {
      event: "missed_entry";
      symbol: string;
      // The historical bar's own timestamp (ISO string from the bars
      // endpoint), NOT when this was detected/logged — the whole point is
      // showing how stale the signal already was by the time it was found.
      barTime: string;
      price: number;
      volume: number | null;
    }
  | {
      event: "exit_filled";
      symbol: string;
      exitReason: "HARD_STOP" | "BREAKEVEN" | "TRAILING" | "EOD";
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      realizedPnl: number;
      holdMinutes: number;
      // Most recent bar's volume as of when the fill was detected — exits
      // are found by polling order status, not from a bar close, so this
      // is "latest known" rather than "the exact bar the fill happened in."
      volume: number | null;
    };

export function logTradeEvent(event: TradeEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.log(`[trade-log] ${event.event} ${"symbol" in event ? event.symbol : ""}`.trim());
}
