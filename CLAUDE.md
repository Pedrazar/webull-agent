# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A hand-rolled Node/TypeScript client and live trading agent for Webull's OpenAPI. No official SDK exists for this language (only Python and Java are officially supported), so `webullClient.ts` re-implements the request-signing algorithm directly, ported from the official Python SDK source vendored at `venv/Lib/site-packages/webull/` — that source tree is the ground truth any time an endpoint path, param name, or response shape is in question. Prefer grepping it over guessing.

The strategy itself is a port of a Webull Script Editor indicator (`EMATrailingStopStrategy`, TypeScript-flavored pseudocode using a `metrix`-style API) into a real broker-connected agent: EMA-9/EMA-20 crossover entry, hard-stop → breakeven → trailing-stop exit, all in flat dollar amounts (not percentages or R-multiples) to match the original script exactly.

## Commands

There's no build step or test framework (`npm test` is a stub) — everything runs directly via `tsx`.

```bash
npx tsc --noEmit          # type-check the whole project
npx tsx main.ts           # run the live agent against sandbox
npx tsx stockScreener.ts  # run the pre-market screener manually
npx tsx testAuth.ts             # smoke test: signature/auth against sandbox
npx tsx testHistoricalBars.ts   # smoke test: historical bars endpoint + response shape
npx tsx testOrderPreview.ts     # smoke test: order preview (safe, no real order)
npx tsx testMqttStream.ts       # smoke test: MQTT connect + live quote/tick decode
npx tsx testMqttResubscribe.ts  # smoke test: confirms re-subscribe (new symbol) is additive, not a replace
npx tsx closeEndOfDay.ts        # one-off: reconcile + force-close every open position via MARKET orders (regular hours only)
npx tsx closeAfterHours.ts      # one-off: same, but LIMIT+GTC+extended_hours_trading for after regular hours
npx tsx checkPositions.ts       # one-off: dump current sandbox positions + open orders as raw JSON
```

`tsconfig.json` must use `"moduleResolution": "bundler"` — the installed TypeScript is v7, which removed the old `"node"` resolution mode (`node10`) entirely.

## Architecture

### Two Webull environments, deliberately kept apart

- **Sandbox** (`WEBULL_APP_KEY`/`WEBULL_APP_SECRET`/`WEBULL_BASE_URL`/`WEBULL_SANDBOX_ACCOUNT_ID` in `.env`) — used for everything that places or manages orders: `main.ts`, `orderManager.ts`, and all market-data reads in `stockScreener.ts`. Sandbox market data mirrors production exactly, so screening decisions made against it are real.
- **Production** (`WEBULL_PROD_APP_KEY`/`WEBULL_PROD_APP_SECRET`/`WEBULL_PROD_BASE_URL`) — used *only* by `prodTokenManager.ts` + the watchlist-push step at the end of `stockScreener.ts`, to sync picks into the real "Gap up" watchlist. Never used for orders. Production endpoints require an `x-access-token` that sandbox does not: a fresh token comes back `PENDING` until the account holder approves it inside the real Webull app, which can't be completed unattended — cached to `prod-token.json` and proactively refreshed 5 days before expiry.

### Daily pipeline

`main.ts` calls the screener itself in-process (`loadOrRunScreener()`) at startup and hourly — there is no separate scheduled screener step.

```
stockScreener.ts → watchlist.json → main.ts → trades.jsonl → run-daily-review.ps1 → daily-reviews/*.md
                 ↘ (also pushes picks to the real "Gap up" watchlist, production only)
```

- **`stockScreener.ts`** — two-pass rules-based screener (no LLM in the loop). Pass 1 pulls `screener/gainers-losers` (PRE_MARKET) + `screener/top-active` (VOLUME), filters cheaply on fields already in that response (price, market cap, gap %, relative volume). Pass 2 enriches only the survivors with float (`stock/snapshot`'s `out_standing_shares`, used as a float proxy — Webull has no separate free-float field) and 10-day average volume (`stock/batch-bars`). Writes the top N to `watchlist.json`; leaves it untouched if nothing survives. Its `runScreener(client?)` export is what `main.ts` calls — the `main()` CLI wrapper (`npx tsx stockScreener.ts`) still works standalone for manual runs (note: a standalone run also triggers the production watchlist push).
- **`main.ts`** — calls `loadOrRunScreener()` at startup (falling back to `watchlist.json` then a hardcoded `MSTZ` if the live run fails or finds nothing). Reconciles broker state, seeds EMA state from historical bars, connects the MQTT stream (TICK for bars/signal, QUOTE for the spread gate only), and on each bar close runs the signal engine and forwards to `OrderManager`. Only the top `AGENT_ACTIVE_SYMBOL_COUNT` (env-overridable, default **4**) of the ranked watchlist are entry-eligible at a time (`activeSymbols`) — the rest stay subscribed/seeded so any already-open position still gets normal exit management. An hourly recheck re-ranks the top N; a symbol rotating in gets seeded + subscribed dynamically (MQTT re-subscribe with a new symbol is additive, confirmed live — no unsubscribe needed).
  - `risk.reconcile()`'s returned symbols get unioned into `startupSymbols` too, so a position that's since rotated out of `watchlist.json` still keeps live price visibility for stop/breakeven/trailing management.
  - **`AGENT_ALWAYS_ACTIVE_SYMBOLS`** (env-overridable, currently **empty**) — forces listed symbols entry-eligible regardless of watchlist ranking. Emptied 2026-10-28 after a `trades.jsonl` analysis found the symbols that had cycled through this slot net -$375, vs. genuinely screener-ranked symbols being net profitable.
  - **`minEntryHourEt`** (`OrderManager` config, env-overridable via `AGENT_MIN_ENTRY_HOUR_ET`) — blocks new entries before a given America/New_York hour; exits/EOD management are unaffected. Added 2026-10-28 (default 13 = 1pm ET) after the same analysis found 9:30am-1pm ET entries losing -$911.70 at 21% win rate vs. +$364.50 at 50% win rate for 1pm+ entries (85-trade sample). **Removed 2026-11-07** at the user's explicit request after the gate was seen repeatedly blocking the same symbol's signal across several sessions — the code and field are still there, just unused by default (`main.ts` no longer passes a value). The underlying data wasn't disproven, just overridden; if morning entries resume dragging on P&L, this is the first place to look.
- **`orderManager.ts`** — the risk/order state machine (`HARD_STOP → BREAKEVEN → TRAILING`), all in dollar amounts to match the Script Editor source. `onPriceUpdate` uses the bar **high**, not close, to arm breakeven/trailing. `checkForFills()` (polled every minute from `main.ts`) is the *only* way a stop/trailing-stop exit is ever observed, since none of those are actions this process initiates.
- **`tradeLogger.ts`** — every entry/rejection/phase-change/exit gets one JSON line in `trades.jsonl`, append-only, the raw material the daily review reads. `entry_placed`/`exit_filled` both carry a `volume` field so the review can spot thin/low-participation trades.
- **`daily-notes.jsonl`** — optional, append-only, one JSON object per line: `{ts, date, note}`. For manual observations that wouldn't otherwise show up in `trades.jsonl` (e.g. a bug caused a missed exit that never got logged). `run-daily-review.ps1` folds today's notes into a "Manual notes" section, treated as ground truth. Nothing writes to this automatically.
- **`run-daily-review.ps1`** — a headless Claude Code subagent (`claude -p ... --allowedTools "Read,Glob,Grep"`), deliberately with **no Write/Bash/Edit access** — structurally incapable of touching the trading code, only of reading logs and producing analysis. It can't use a Write tool unattended in headless mode (confirmed live — it just hangs), so it outputs the report as plain reply text, which the calling PowerShell script saves to `daily-reviews/<date>.md`. That script forces `[Console]::OutputEncoding`/`$OutputEncoding` to UTF-8 to avoid mangling non-ASCII output through the legacy console codepage.
  - The review leads with **expectancy and the P&L trend**, not single-day win rate — with well under 10 trades/day, daily win rate swinging between 0% and 100% is normal noise, not signal.

### Signature algorithm (the part any endpoint work depends on)

`webullClient.ts`'s `calcSignature()` is a verified port of `default_signature_composer.py` / `sha_hmac256_new.py`: HMAC-SHA256 (despite the Python module being named `sha_hmac1`), base64 digest, secret has a trailing `&` appended before signing, canonical string is `uri&sorted_key=value&...&BODY_HASH` (body hash = uppercase SHA-256 hex), and the whole thing is percent-encoded matching Python's `quote(s, safe='')` (`pythonQuote()` patches the extra characters `encodeURIComponent` leaves alone). `host` participates in the signature but is never sent as an actual header. Proven live against both sandbox and production.

### Non-obvious API facts worth knowing before touching order/position code

- Every numeric field in every Webull response is a **string** — always `parseFloat`.
- Cancel and replace key off `client_order_id`, not the `order_id` the place call also returns.
- Cancelling immediately after placing an order can hit `OAUTH_OPENAPI_ORDER_CAN_NOT_BE_CANCEL_FOR_PENDING_SUBMIT` — a real timing race, handled with retry-with-backoff in `cancelOrderWithRetry`.
- The `TRAILING_STOP_LOSS` order type places and rests fine but its `stop_price` never actually moves as price rises (confirmed live) — see "Trailing is client-side" below; do not reintroduce it without re-verifying live first.
- Watchlist list/add/remove all key off `watchlist_id` with `{ symbol, category, sort? }` instrument objects.

## Strategy parameters (must match the Script Editor source, not be re-derived)

Currently in `main.ts`: `hardStopAmount: 0.15`, `breakevenActivationAmount: 0.2`, `trailingActivationAmount: 0.3`, `trailingStopAmount: 0.1`, `quantity: 300`, `minPrice: 1`, `maxPrice: 20`, `maxSpread: 0.03`, `minEntryVolume: 5,000` (env-overridable via `AGENT_MIN_ENTRY_VOLUME`), `maxDailyLossUsd: 150`. Screener thresholds (env-overridable, see `SCREENER_*` vars at the top of `stockScreener.ts`): market cap > $300M, gap ≥ 5% (gap up only — long-only strategy), 10-day avg volume > 1M, relative volume (10d) > 2, float > 20M. If the real Script Editor strategy's inputs ever change, these need to change with it — they are not independently tuned.

**Deliberate deviations from the Script Editor source** (the original has none of these):
- **Minimum EMA separation filter** — `SignalEngine`'s `minSeparationPct` (0.3%, main.ts's constructor arg): a crossover only counts if EMA-9/EMA-20 are at least that far apart, added after a real whipsaw (PSNL stopped out at breakeven, then re-entered 4 minutes later on a bounce-back at a worse price).
- **Confirmation window** (`confirmationWindowBars`, default 10) — fixes a gap the separation filter created: `crossedUp`/`crossedDown` only fire once at the exact flip bar, so a cross too marginal to fire immediately used to be dropped forever even if separation grew past the threshold a few bars later. Now a filtered cross is tracked "pending" for up to N bars and fires then if it clears the threshold before a reversal or timeout.
- **Signal-bar volume floor** (`minEntryVolume`, rejection reason `volume_too_low`) — rejects entries whose triggering bar's volume is below the floor. Added after a real entry fired on a 100-share signal bar (two to three orders of magnitude thinner than every other entry that day).
- **Per-symbol cooldown** (`cooldown.ts`) — the one piece that adapts based on outcomes rather than staying fixed until a human edits it. `computeCooldownSymbols()` is a pure function over `trades.jsonl`: if a symbol's most recent `AGENT_COOLDOWN_STREAK` exits (default 3) are all losses, it's excluded from new entries (reason `symbol_on_cooldown`) until `AGENT_COOLDOWN_DAYS` (default 2 calendar days) past the last loss. Computed fresh at every startup, before `reconcile()` — no separate mutable state, fully auditable from the log alone. Deliberately scoped to streak-counting only, not correlation-based tuning (e.g. auto-loosening `maxSpread`) — left as a known-deferred v2 until there's meaningfully more trade history.

**Trailing is client-side, not a broker order type.** Webull's `TRAILING_STOP_LOSS` places and rests correctly but its `stop_price` does not move as price rises (confirmed live: a position ran well past its peak with the broker-reported trailing stop frozen at its initial level, only filling on the way back down at a stale price). `orderManager.ts` places a plain `STOP_LOSS` instead and `ratchetTrailingStop()` moves it up itself via `order/replace` every bar while in `TRAILING` phase.

## Scheduling and hosting

**Current state: GitHub Actions, public repo.** The agent + screener previously ran via local Windows Task Scheduler but repeatedly missed its morning trigger due to the laptop sleeping (lid-close and idle-timeout, even after logon-type fixes, wake timers, and sleep-prevention tasks) — cost several real trading days before moving off the laptop entirely on 2026-08-25/26. Do not re-enable the old local tasks (`WebullAgentStart`/`WebullWatchlistScreener`) while the GitHub Actions workflow is also active — that would double-trade the same sandbox account.

- **Repo**: `https://github.com/Pedrazar/webull-agent` — **public** (changed 2026-09-07 after the free 2,000 Actions-minutes/month tier was nearly exhausted by a single wasted holiday session; verified first via full-history grep that no secrets were ever committed — all 4 Webull credentials live only as GitHub Secrets). Trade-off accepted knowingly: source, strategy params, and trade history are publicly visible.
- **Primary trigger**: an external **cron-job.org** job `POST`s to the workflow's `workflow_dispatch` endpoint at 6:29am PT (= 9:29am ET year-round, since ET is always exactly 3 hours ahead of PT) using a fine-grained GitHub PAT. This exists because GitHub's own `schedule` event proved unreliable for this repo — confirmed live multiple times with triggers firing hours late or not at all, including once with all three redundant in-repo slots landing late together. `workflow_dispatch` itself is not subject to that delay.
- **Backup triggers**: three redundant in-repo `schedule` cron slots (13:17, 13:47, 14:17 UTC, deliberately off the top of the hour) are left in place as a harmless fallback — a `concurrency: group: trading-agent-session, cancel-in-progress: false` block means a late/redundant fire just queues and no-ops via `exitIfPastClose()` once its turn comes.
- **DST handled in-process, not via cron**: `main.ts` gates on real `America/New_York` time (`nyNow()`), so `waitForMarketOpen()`/`exitIfPastClose()`/`isPastEodCloseTime()` are correct regardless of season with no dual-cron trickery needed.
- **Timeout**: `timeout-minutes: 355`, under GitHub's 360-min hosted-runner hard cap. This margin matters — an earlier `350` setting didn't account for pre-open wait time and got force-killed by GitHub 20 minutes before its own EOD close could run (harmless that day only because the one open position had already hit its hard stop). EOD close is **3:20pm ET** in `main.ts` (tightened from an original 3:55pm, then loosened slightly back from a too-tight 3:15pm) — keep this and `timeout-minutes` in sync if either changes; measured end-to-end runtime has come in around ~346 min against the 355 budget.
- **Holiday calendar**: `main.ts` hardcodes `NYSE_HOLIDAYS` (2026-2027) and exits immediately at startup on a full-closure day — added after a wasted ~5-hour Labor Day session. Does **not** cover early-close half-days (e.g. the Friday after Thanksgiving) — a known, smaller residual gap. Needs manual annual top-up (Good Friday and others are movable).
- **Screener runs in-process**, not as a separate job — `runScreener()` is called directly by `main.ts`.
- **Production watchlist push is deliberately out of scope in Actions** — `WEBULL_PROD_APP_KEY`/`SECRET` were never added as repo secrets, so `pushToGapUpWatchlist` silently no-ops, keeping the cloud runner's credential footprint sandbox-only.
- **Daily review stays local** (`run-daily-review.ps1` via Windows Task Scheduler, `WebullDailyReview`) — not time-critical the way missing a trading day is, and moving it to Actions would need separate Anthropic API billing.
- **Persistence**: `trades.jsonl`, `watchlist.json`, `daily-notes.jsonl` are intentionally git-tracked (Actions' filesystem is ephemeral per run); the workflow's final step commits + pushes them (`if: always()`, so a partial/failed day's data isn't lost; no commit at all on a no-trades day).
- **Git commit-race fix (2026-11-03)**: two concurrent runs both touching the same three files could hit a real `git pull --rebase` conflict that silently discarded whichever run's commit couldn't be rebased — recurred three times (2026-09-01/08, 2026-10-09 lost a real +$96 trade, 2026-11-03 lost a log-only entry). Fixed via `.gitattributes` (`trades.jsonl`/`daily-notes.jsonl` as `merge=union` — pure append-only logs, keep every line from both sides; `watchlist.json` as `merge=ours` — fully regenerated each run, nothing to reconcile) plus a 5-attempt retry loop in `agent.yml`'s commit step for the separate, more common race of origin moving again between an attempt's rebase and push. Verified conflict-free in a scratch repo before shipping.
- **Known residual gap in crossover detection on a late start**: `seedSymbol()` splits historical-bar seeding at today's market open — pre-open bars go through silent EMA warmup, but at-or-after-open bars are replayed through the real signal-detection path so a crossover that happened before the live stream connected still gets caught (logged as `missed_entry`, deliberately never auto-traded, since the original entry price is already gone). If a start is so late that the entire 30-bar/30-min lookback falls after the open, there are no pre-open bars left to warm up EMA state from, so real crossovers won't be evaluated until ~20 bars into the replay — not yet hit in practice.

## EOD close: known-fixed bug + a real remaining gap

Root cause of an early failed close (both open positions failed to flatten): cancelling a stop order and immediately placing the flattening `MARKET` sell raced the broker's own bookkeeping (cancel returned success before the shares were released back to "available to sell"). Fixed in `orderManager.ts` by polling the cancel to a terminal state before placing the sell, and by isolating each position's close in its own try/catch so one failure can't abort the rest of the loop.

**Still open, a real gap**: `closeAllEndOfDay()` only ever places `MARKET` orders, which Webull rejects outside regular hours. Normally a non-issue since the close trigger fires well before 4pm ET, but there is no extended-hours fallback wired into `closeAllEndOfDay()` itself if a close is ever missed or retried late. `closeAfterHours.ts` is a standalone one-off that handles this case (LIMIT + GTC + `extended_hours_trading: true` — confirmed live that a plain DAY limit order is rejected after hours too) but isn't wired into the main flow. Also worth knowing: the OpenAPI sandbox account is entirely separate from Webull's consumer-app "paper trading" feature — they don't share positions or orders.

## Remaining gaps before this touches real money

MQTT bar/topic payload shape was confirmed empirically rather than from a written spec (worth re-checking against official docs if behavior ever seems off), and this has only ever been paper-traded — the README's original recommendation of several weeks of paper trading before real capital still stands. Production credentials exist now, but *only* for the watchlist push; no order-placement code path has ever been pointed at production, and doing so would need the same live re-verification treatment every sandbox-confirmed endpoint already got.
