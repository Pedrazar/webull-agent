/**
 * Per-symbol cooldown after N consecutive losses — the one piece of the
 * agent that actually adapts based on trade outcomes. Deliberately scoped
 * to counting a losing streak, not inferring correlations (e.g. "low
 * entry volume predicts losses") — with only a few dozen trades of
 * history total, correlation-based tuning would mostly fit noise. A
 * losing streak needs no such inference: 3 losses in a row is just 3
 * losses in a row.
 *
 * Computed fresh from trades.jsonl at every startup — no separate mutable
 * state file, so it's inherently self-healing (a win breaks the streak,
 * the window naturally expires) and fully auditable (the "why" for any
 * cooldown is just that symbol's last few exit_filled events).
 */

import { TradeEvent } from "./tradeLogger";

export type LoggedTradeEvent = TradeEvent & { ts: string };

export interface CooldownInfo {
  until: number; // epoch ms
  reason: string;
}

const MS_PER_DAY = 86_400_000;

export function computeCooldownSymbols(
  trades: LoggedTradeEvent[],
  now: Date,
  opts: { streak: number; days: number }
): Map<string, CooldownInfo> {
  const exitsBySymbol = new Map<string, Extract<LoggedTradeEvent, { event: "exit_filled" }>[]>();
  for (const t of trades) {
    if (t.event !== "exit_filled") continue;
    const list = exitsBySymbol.get(t.symbol) ?? [];
    list.push(t);
    exitsBySymbol.set(t.symbol, list);
  }

  const result = new Map<string, CooldownInfo>();
  const nowMs = now.getTime();

  for (const [symbol, exits] of exitsBySymbol) {
    exits.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    if (exits.length < opts.streak) continue;

    const recent = exits.slice(-opts.streak);
    if (!recent.every((e) => e.realizedPnl < 0)) continue;

    const last = recent[recent.length - 1];
    const until = new Date(last.ts).getTime() + opts.days * MS_PER_DAY;
    if (until <= nowMs) continue; // streak is real but the cooldown window already elapsed

    const pnls = recent.map((e) => (e.realizedPnl < 0 ? `-$${Math.abs(e.realizedPnl).toFixed(2)}` : `$${e.realizedPnl.toFixed(2)}`)).join(", ");
    result.set(symbol, {
      until,
      reason: `${opts.streak} consecutive losses: ${pnls} (last ${last.ts})`,
    });
  }

  return result;
}
