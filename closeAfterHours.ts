/**
 * One-off, after-hours only: close every open equity position with a LIMIT
 * sell order (extended_hours_trading: true), since Webull rejects MARKET
 * orders outside regular hours (OAUTH_OPENAPI_CAN_NOT_TRADING_FOR_FIXGW_NOT_READY_MARKET).
 *
 * UNVERIFIED until this run: LIMIT order placement and extended_hours_trading
 * have never been exercised in this codebase before (see CLAUDE.md's "EOD
 * close" section). Field names (`limit_price`, `extended_hours_trading`)
 * are taken from the vendored Python SDK's order_operation.py docstrings,
 * not yet confirmed against this project's actual v3 new_orders shape.
 *
 * Limit price: last traded price minus a small cent buffer, aggressive
 * enough to be marketable against the current bid in a thin after-hours book.
 */
import "dotenv/config";
import { WebullClient } from "./webullClient";
import { logTradeEvent } from "./tradeLogger";

const LIMIT_BUFFER = 0.03;

interface PositionResponse {
  symbol: string;
  quantity: string;
  cost_price: string;
  last_price: string;
  instrument_type: string;
}

interface OrderDetailResponse {
  orders?: Array<{ status: string; filled_price: string | null; filled_quantity: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollFill(
  rest: WebullClient,
  accountId: string,
  clientOrderId: string,
  maxAttempts = 6,
  delayMs = 2000
): Promise<{ status: string; filledPrice: number | null; filledQuantity: number } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const detail = await rest.get<OrderDetailResponse>("/openapi/trade/order/detail", {
      account_id: accountId,
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
    console.log(`  poll ${attempt}/${maxAttempts}: status=${order?.status ?? "unknown"}`);
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return null;
}

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  const rest = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const positions = await rest.get<PositionResponse[]>("/openapi/assets/positions", { account_id: accountId });
  const equityPositions = positions.filter((p) => p.instrument_type === "EQUITY" && parseFloat(p.quantity) > 0);

  if (equityPositions.length === 0) {
    console.log("No open equity positions.");
    return;
  }

  for (const pos of equityPositions) {
    const quantity = parseFloat(pos.quantity);
    const lastPrice = parseFloat(pos.last_price);
    const limitPrice = +(lastPrice - LIMIT_BUFFER).toFixed(2);
    const entryPrice = parseFloat(pos.cost_price);
    const clientOrderId = crypto.randomUUID().replace(/-/g, "");

    console.log(`\n${pos.symbol}: selling ${quantity} @ LIMIT ${limitPrice} (last=${lastPrice}), extended hours`);

    try {
      await rest.post("/openapi/trade/stock/order/place", {
        account_id: accountId,
        new_orders: [
          {
            entrust_type: "QTY",
            support_trading_session: "CORE",
            combo_type: "NORMAL",
            instrument_type: "EQUITY",
            market: "US",
            client_order_id: clientOrderId,
            symbol: pos.symbol,
            side: "SELL",
            order_type: "LIMIT",
            limit_price: String(limitPrice),
            extended_hours_trading: true,
            quantity: String(quantity),
            time_in_force: "GTC",
          },
        ],
      });

      const fill = await pollFill(rest, accountId, clientOrderId);
      if (!fill) {
        console.warn(`  ${pos.symbol}: no terminal status within poll window — order may still be resting`);
        continue;
      }
      if (fill.status !== "FILLED") {
        console.warn(`  ${pos.symbol}: order ended as ${fill.status}, not filled`);
        continue;
      }

      const exitPrice = fill.filledPrice ?? limitPrice;
      const filledQty = fill.filledQuantity || quantity;
      const realizedPnl = (exitPrice - entryPrice) * filledQty;
      console.log(`  ${pos.symbol}: FILLED @ ${exitPrice}, realizedPnl=${realizedPnl.toFixed(2)}`);

      logTradeEvent({
        event: "exit_filled",
        symbol: pos.symbol,
        exitReason: "EOD",
        entryPrice,
        exitPrice,
        quantity: filledQty,
        realizedPnl,
        holdMinutes: 0, // unrecoverable here — this is a standalone close script, not the live agent
        volume: null, // no bar data available outside the live agent
      });
    } catch (err) {
      console.error(`  ${pos.symbol}: close failed:`, err);
    }
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
