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

- **Sandbox** (`WEBULL_APP_KEY`/`WEBULL_APP_SECRET`/`WEBULL_BASE_URL`/`WEBULL_SANDBOX_ACCOUNT_ID` in `.env`) — used for everything that places or manages orders: `main.ts`, `orderManager.ts`, and all market-data reads in `stockScreener.ts`. Confirmed live that sandbox market data is an exact mirror of production (identical snapshot fields for the same symbol at the same instant) — it is not synthetic, so screening decisions made against it are real.
- **Production** (`WEBULL_PROD_APP_KEY`/`WEBULL_PROD_APP_SECRET`/`WEBULL_PROD_BASE_URL`) — used *only* by `prodTokenManager.ts` + the watchlist-push step at the end of `stockScreener.ts`, to sync picks into the real "Gap up" watchlist. Never used for orders. Production endpoints require an `x-access-token` that sandbox does not: a fresh token comes back `PENDING` until the account holder approves it inside the real Webull app (see the `create`/`check`/`refresh` flow docs in `prodTokenManager.ts`) — this cannot be completed unattended, which is why the token is cached to `prod-token.json` and proactively refreshed 5 days before expiry rather than re-requested each run.

### Daily pipeline (also see Scheduling below)

**Current, since 2026-08-25/26 — see Remote hosting below for the authoritative picture**:
`main.ts` calls the screener itself in-process (`loadOrRunScreener()`) at
startup and hourly; there is no longer a separate scheduled screener step.
The diagram and description right below predate that change and describe
the original local architecture — kept for how the pieces work internally
(still accurate for that), not for how/when they're invoked now.

```
stockScreener.ts → watchlist.json → main.ts → trades.jsonl → run-daily-review.ps1 → daily-reviews/*.md
                 ↘ (also pushes picks to the real "Gap up" watchlist, production only)
```

- **`stockScreener.ts`** — two-pass rules-based screener (no LLM in the loop). Pass 1 pulls `screener/gainers-losers` (PRE_MARKET) + `screener/top-active` (VOLUME), filters cheaply on fields already in that response (price, market cap, gap %, relative volume). Pass 2 enriches only the survivors with float (`stock/snapshot`'s `out_standing_shares`, used as a float proxy — Webull has no separate free-float field) and 10-day average volume (`stock/batch-bars`), to avoid one API call per candidate. Writes the top N to `watchlist.json`; leaves it untouched if nothing survives, rather than clobbering it with an empty list. Its `runScreener(client?)` export is what `main.ts` actually calls now (see Remote hosting) — the `main()` CLI wrapper (`npx tsx stockScreener.ts`) still works standalone for manual runs.
- **Reconciled positions outside today's watchlist get tracked too.** `risk.reconcile()` returns the symbols it found open positions for; `main.ts` unions those into `startupSymbols` (seeding EMA state and the live MQTT subscription) even if they've since rotated out of `watchlist.json`. Without this, discovered live on 2026-08-20: a restart right after the watchlist rotated to a new top symbol left an existing PSNL position with a resting stop order but zero live price visibility — no bars, so breakeven/trailing management silently stopped running for it, even though the position and its stop were both still perfectly real at the broker.
- **`main.ts`** — calls `loadOrRunScreener()` at startup (in-process screener run, falling back to reading `watchlist.json` then a hardcoded `MSTZ` if that fails or finds nothing — the fallback is what the rest of this bullet still describes). Reconciles broker state, seeds EMA state from historical bars, connects the MQTT stream (TICK for bars/signal, QUOTE for the spread gate only — QUOTE never touches bar construction), and on each bar close runs the signal engine and forwards to `OrderManager`. Only the top `AGENT_ACTIVE_SYMBOL_COUNT` (env-overridable, default **2**) of the ranked watchlist are entry-eligible at a time (`activeSymbols`) — the rest of the tracked set stays subscribed/seeded so any already-open position in a symbol that later drops out of the top N still gets normal exit management, it just can't open new positions. An hourly `setInterval` re-runs `loadOrRunScreener()` and re-ranks the top N. A symbol that rotates into the top N and wasn't already tracked gets dynamically added: seeded from historical bars via `seedSymbol()`, then added to the live MQTT session via `stream.subscribeSymbols()`. CONFIRMED live via `testMqttResubscribe.ts` (2026-08-19) that re-POSTing `/openapi/market-data/streaming/subscribe` with just the new symbol is **additive** — the existing subscription keeps flowing without needing to be resent, so no unsubscribe call is needed on this path. (This replaced an earlier warn-only fallback after a real miss: PSNL crossed over shortly after entering the top 2 and the agent — pre-fix — never saw it because it wasn't part of the original startup `SYMBOLS`, requiring a manual restart to pick it up.)
  - **Added 2026-08-22**: `AGENT_ALWAYS_ACTIVE_SYMBOLS` (env-overridable, default `MSTZ,NVTS`) are entry-eligible at all times, on top of (not instead of) the top-N watchlist symbols — `topActiveSymbols()` unions them in regardless of watchlist ranking. They're also force-included in `startupSymbols` at boot (seeded + subscribed) even if absent from today's `watchlist.json`, so they're live-tracked from minute one rather than waiting on the hourly rotation-in path.
- **`orderManager.ts`** — the risk/order state machine (`HARD_STOP → BREAKEVEN → TRAILING`), all in dollar amounts to match the Script Editor source. `onPriceUpdate` uses the bar **high**, not close, to arm breakeven/trailing (matches the original script's `bar.high` checks). `checkForFills()` (polled every minute from `main.ts`) is the *only* way a stop/trailing-stop exit is ever observed — none of those are actions this process initiates, so without the poll they'd never be logged and `dailyPnl` (which gates the kill switch) would never update.
- **`tradeLogger.ts`** — every entry/rejection/phase-change/exit gets one JSON line in `trades.jsonl`. This is the raw material the daily review reads; never rewritten, only appended. `entry_placed`/`exit_filled` both carry a `volume` field (added 2026-08-21, per user request, for the daily review to spot thin/low-participation trades) — entries read it straight from the triggering bar; exits are detected by `checkForFills()`/`closeAllEndOfDay()` polling order status independently of any bar close, so `OrderManager.setVolumeSource()` wires in `main.ts`'s `latestBarVolume` map (by reference) and exits report "most recent known volume as of the fill," not the exact bar the fill executed in.
- **`daily-notes.jsonl`** (new, 2026-08-20) — optional, append-only, one JSON object per line: `{ts, date, note}`. For manual observations that wouldn't otherwise show up in `trades.jsonl` — e.g. a bug caused a missed exit that never got logged as a trade event, so the raw numbers alone would misread the day. `run-daily-review.ps1`'s prompt reads this (filtered to today's `date`) and folds it into a "Manual notes" section, treated as ground truth. No script writes to this automatically — append a line by hand (or ask Claude to) when something happened that the trade log itself can't capture.
- **`run-daily-review.ps1`** — a headless Claude Code subagent (`claude -p ... --allowedTools "Read,Glob,Grep"`), deliberately with **no Write/Bash/Edit access** — it is structurally incapable of touching `orderManager.ts`/`main.ts`/`stockScreener.ts`, only of reading logs and producing analysis. It cannot use a Write tool at all in headless mode without a human present to approve the permission prompt (confirmed live — it just hangs), so it's told to output the full report as plain reply text, which the calling PowerShell script saves to `daily-reviews/<date>.md`. That script also has to force `[Console]::OutputEncoding`/`$OutputEncoding` to UTF-8, or non-ASCII characters in the child process's output (em dashes, etc.) get mangled through the legacy console codepage.

### Signature algorithm (the part any endpoint work depends on)

`webullClient.ts`'s `calcSignature()` is a verified port of `default_signature_composer.py` / `sha_hmac256_new.py`: HMAC-SHA256 (despite the Python module being named `sha_hmac1`), base64 digest, secret has a trailing `&` appended before signing, canonical string is `uri&sorted_key=value&...&BODY_HASH` (body hash = uppercase SHA-256 hex), and the whole thing is percent-encoded matching Python's `quote(s, safe='')` (`pythonQuote()` patches the extra characters `encodeURIComponent` leaves alone). `host` participates in the signature but is never sent as an actual header. All of this is proven live against both sandbox and production, not just plausible from reading the source.

### Non-obvious API facts worth knowing before touching order/position code

- Every numeric field in every Webull response is a **string** — always `parseFloat`.
- Cancel and replace key off `client_order_id`, not the `order_id` the place call also returns.
- Cancelling immediately after placing an order can hit `OAUTH_OPENAPI_ORDER_CAN_NOT_BE_CANCEL_FOR_PENDING_SUBMIT` — a real timing race, handled with retry-with-backoff in `cancelOrderWithRetry`.
- The `TRAILING_STOP_LOSS` order type places and rests fine but CONFIRMED live (2026-08-20) that its `stop_price` never actually moves as price rises — see the Strategy parameters section below and the comment in `orderManager.ts` before ever reintroducing it.
- Watchlist list/add/remove all key off `watchlist_id` with `{ symbol, category, sort? }` instrument objects.

## Strategy parameters (must match the Script Editor source, not be re-derived)

Currently in `main.ts`: `hardStopAmount: 0.15`, `breakevenActivationAmount: 0.2`, `trailingActivationAmount: 0.3`, `trailingStopAmount: 0.1` (changed from `0.15` on 2026-08-20, alongside the trailing rework below — a deliberate user decision, not derived from the Script Editor source), `quantity: 300`, `minPrice: 1`, `maxPrice: 20`, `maxSpread: 0.03`, `minEntryVolume: 5,000` (env-overridable via `AGENT_MIN_ENTRY_VOLUME`, added 2026-09-03), `maxDailyLossUsd: 120`. Screener thresholds (env-overridable, see `SCREENER_*` vars at the top of `stockScreener.ts`): market cap > $300M, gap ≥ 5% (**gap up only** — the strategy is long-only, so this is a deliberate interpretation, not a given), 10-day avg volume > 1M, relative volume (10d) > 2, float > 20M. If the real Script Editor strategy's inputs ever change, these need to change with it — they are not independently tuned.

**Signal-bar volume floor, added 2026-09-03.** `OrderManager.enterLong()` now rejects (reason `"volume_too_low"`, logging the actual volume) any entry whose triggering bar's volume is below `minEntryVolume`. Motivated by a real SID entry on 2026-09-03 that fired on a **100-share** signal bar — two to three orders of magnitude thinner than every other entry that day (51K–212K) — a low-participation/possibly-stale-tick fill that happened to scratch at breakeven rather than costing real money, but was exactly the pattern the daily review flagged as worth a hard gate rather than trusting luck again. Reads `this.latestVolume(symbol)` — the same `volumeSource` map already wired in for entry/exit volume *logging* (added 2026-08-21) — so no new plumbing was needed, just a new check against an existing, already-populated value. Fails closed like the spread check right above it: a `null`/unavailable volume blocks the entry rather than allowing it through.

**Minimum EMA separation filter, added 2026-08-20.** `SignalEngine`'s constructor takes `minSeparationPct` (main.ts passes `0.003` = 0.3%) — a crossover only counts as a signal if EMA-9 and EMA-20 are at least that far apart (as a fraction of EMA-20). Motivated by a real observed whipsaw: PSNL got stopped out at breakeven, then a fresh crossover fired 4 minutes later on the bounce back through, entering at a worse price than the position that had just been stopped out — the visual signature of a flat/choppy market repeatedly whipsawing a bare EMA crossover. This is a **deliberate deviation from the Script Editor source**, not derived from it — the original strategy has no such filter, so if the real Script Editor indicator's behavior is ever the source of truth to re-match, this needs to be called out as an intentional addition, not reconciled away.

**Confirmation window, added 2026-08-26** (second constructor arg, `confirmationWindowBars`, default `10`): fixes a real gap the separation filter itself created. A cross that's too marginal to fire immediately used to just be dropped — but `crossedUp`/`crossedDown` only fire once, at the exact bar EMA-9 flips sides, so if that one-shot check got filtered, there was no second chance even if the move turned out to be real: EMA-9 doesn't cross again while it's already sitting on the new side, no matter how far separation grows afterward. Found live: MSTZ crossed up 2026-08-26 with only 0.003% separation (correctly filtered as noise), but separation grew past 0.3% just 7 bars later as price ran from $5.87 to $6.08 — a real, tradeable move the strategy had no way to ever catch under the old one-shot logic. Now a filtered cross is tracked as "pending" for up to `confirmationWindowBars` subsequent bars; if separation crosses the threshold before a reversal or the window expires, it fires then (confirmed live via replay against today's actual bars — fired at 14:25 UTC, 7 bars after the 14:18 marginal cross, exactly matching the move the user spotted on their chart). A reversal (an opposite-direction cross) before confirming clears the pending state — that setup is gone regardless of which way it resolved. `onBarClose()` also gained an optional `log` param (defaults to `console.log`) purely so the pending/confirmed/expired transitions are visible in the agent's log output instead of being invisible the way the original one-shot filter's "too marginal" drops always were.

**Trailing is client-side, not a broker order type.** CONFIRMED live 2026-08-20 that Webull's `TRAILING_STOP_LOSS` order type places and rests correctly but its `stop_price` does not actually move as price rises — MRVI ran from a peak of 8.27 to 8.34 over 20+ minutes while the broker-reported trailing stop sat frozen at its initial 8.12, only filling on the way back down at that stale level (a real, quantifiable missed exit — should have caught roughly 8.19+, filled at 8.11 instead). `orderManager.ts` no longer places that order type at all: `startTrailing()` places a plain `STOP_LOSS`, and `ratchetTrailingStop()` (called every bar from `onPriceUpdate` while in `TRAILING` phase) moves it up itself via `order/replace` — the same proven mechanism `moveStopToBreakeven()` already used — whenever `OpenPosition.highestPrice - trailingStopAmount` exceeds the currently-resting `stopPrice`. Do not reintroduce `TRAILING_STOP_LOSS` for trailing without re-verifying it live first.

**Per-symbol cooldown after a losing streak, added 2026-09-01** (`cooldown.ts`, wired into `orderManager.ts`/`main.ts`) — the one piece of the agent that adapts based on trade outcomes rather than staying fixed until a human edits it. Motivated directly by the user: everything above this point (the daily review, every strategy parameter) is human-in-the-loop only — the review is explicitly sandboxed to `Read/Glob/Grep` and prompted never to self-apply its own suggestions, and nothing at runtime reads `trades.jsonl` or `daily-reviews/`. `computeCooldownSymbols()` is a pure function: it filters `trades.jsonl` to `exit_filled` events, groups by symbol, and if a symbol's most recent `AGENT_COOLDOWN_STREAK` exits (env-overridable, default `3`) are *all* losses, it's excluded from new entries (`entry_rejected` reason `"symbol_on_cooldown"`, with a `cooldownReason` field spelling out the exact losses) until `AGENT_COOLDOWN_DAYS` (default `2`, **calendar** days, not trading days — a documented simplification, not worth weekday-aware date math for a 2-day default window) past the last of those losses. Computed fresh from `trades.jsonl` — already the git-committed source of truth — at every `main.ts` startup, before `reconcile()`, so it's active before any entry could possibly fire; no separate mutable state file, so it's inherently self-healing (a win breaks the streak, the window just expires) and fully auditable (the "why" for any cooldown is that symbol's own last few `exit_filled` events, nothing hidden). The daily review surfaces active cooldowns in their own section when present (`run-daily-review.ps1`).

Deliberately scoped to counting a losing streak, not inferring correlations (e.g. auto-loosening `maxSpread` because spread-rejected setups seem to correlate with wins/losses, or nudging `minSeparationPct` based on entry-volume patterns) — **left as a known-deferred v2**. With only a few dozen realized trades of history total, correlation-based threshold tuning would mostly be fitting noise; a losing streak needs no such inference. Revisit only once there's meaningfully more trade history to support it responsibly.

## Scheduling

**Status as of 2026-08-28 — most of this section is history, not live config.**
Of the five Windows Task Scheduler tasks discussed below, only
`WebullDailyReview` is still enabled. `WebullAgentStart` and
`WebullWatchlistScreener` were disabled 2026-08-26 (moved to GitHub
Actions — see Remote hosting below). `WebullPreventLidSleep` and
`WebullRestoreLidSleep` were disabled 2026-08-28 (nothing local needs the
laptop kept awake all day anymore, now that the agent runs remotely). The
incident history below (S4U, Session 0, sleep root-causes, `WakeToRun`)
is kept because it's real postmortem material and the lessons (especially
around `WebullDailyReview`, which still uses S4U + `WakeToRun`) remain
relevant — just don't read the task list below as "what's currently
running."

Windows Task Scheduler, weekdays only, local (Pacific) time: `WebullWatchlistScreener` (6:00 AM, then repeats every hour for 6 hours — also 7/8/9/10/11/12:00, so the watchlist re-ranks intraday) → `WebullAgentStart` (6:30 AM = NYSE open) → `WebullDailyReview` (1:15 PM = 4:15 PM ET, after close). Task definitions run `run-screener.cmd` / `run-agent.cmd` / `run-daily-review.ps1` respectively; all three log to timestamped `*.log` files in the project root (gitignored). The hourly screener reruns are what make `main.ts`'s hourly top-N recheck (see above) actually see anything change. The screener's last run is deliberately 12:00 PM (3:00pm ET) rather than 1:00pm — a run right at the 1:00pm/4:00pm ET close would find picks with no trading time left to act on them before the EOD close (see below — moved to 3:25pm ET on 2026-08-25).

**Effective close moved up 30 min, 2026-08-25**: deliberate choice, not a bug fix — the user doesn't value the last half hour of the session. `main.ts`'s EOD flatten trigger moved from 3:55pm ET to **3:25pm ET** (still 5 min ahead of the new effective 3:30pm ET close), so `closeAllEndOfDay()` now fires half an hour earlier. This also matters for a possible future remote-hosting move (see below): a 9:30am-3:30pm ET session is a 6-hour window, which fits inside GitHub Actions hosted-runner's 6-hour job cap — the original 9:30am-4:00pm ET (6.5hr) session did not.

**Logon type: S4U, not Interactive.** All three tasks run with `LogonType=S4U` (principal XML backups in `.task-xml/`, re-imported via `schtasks /Create /XML ... /F` from an elevated prompt — `Set-ScheduledTask`/`schtasks /Change` cannot change LogonType without admin rights, only XML re-import can, and even that needs a genuinely elevated shell, not just an account that's in the Administrators group). This was a fix, not the original config: `InteractiveToken` logon type caused two real incidents on 2026-08-19/20 — `WebullAgentStart`'s 6:30am trigger and (separately, the next day) `WebullWatchlistScreener`'s 6:00am trigger were each silently missed, and Windows' own "run the missed trigger once conditions allow" catch-up mechanism failed both times with `0x800710E0` ("The operator or administrator has refused the request") — a known quirk where Interactive-logon tasks can't be started outside a live, direct trigger-firing moment. S4U doesn't depend on an interactive desktop session being active, so catch-up runs (including the battery-power-restored case from the first incident) should no longer hit this.

**Tradeoff discovered same day**: S4U-launched processes run in **Session 0** (isolated, non-interactive), not the normal interactive desktop session. A normal (non-elevated) interactive shell can `Get-Process`/see the PIDs but gets `Access is denied` trying to `Stop-Process`/`taskkill` them — and `schtasks /End /TN ...` reports success without actually killing the underlying `node.exe` descendants (it only reaps whatever direct child it spawned, which detaches from the real process tree). Stopping the live agent to deploy a code change now requires an **elevated** PowerShell, every time — plan for that when doing a manual restart mid-day.

**Correction, 2026-08-20 afternoon**: S4U does NOT fully solve the missed-trigger problem — `WebullDailyReview` (already S4U at the time) missed its 1:15pm trigger and its catch-up attempt failed with the identical `0x800710E0`, proving LogonType wasn't the whole story. The actual cause, confirmed via the System event log (`Microsoft-Windows-Kernel-Power`, event IDs 506/507): **the laptop was in Modern Standby (asleep) through the trigger time, having entered standby via lid-close, and woke at 1:55:58pm — one second before the failed catch-up attempt.** Windows cannot fire a trigger while the machine is asleep, and its post-wake catch-up for a missed task consistently fails regardless of LogonType. Likely explains the 2026-08-19/20-morning incidents too, not just LogonType — those were never disambiguated from a sleep cause before the S4U fix was applied. S4U is still the right choice for these tasks (no reason to revert it), it just wasn't sufficient on its own.

**Fixed, 2026-08-20 (DISABLED 2026-08-28 — see Remote hosting)**: `WebullPreventLidSleep` (5:45am weekdays) and `WebullRestoreLidSleep` (1:30pm weekdays) toggled lid-close-action between "Do nothing" (trading hours) and this laptop's normal AC=Sleep/DC=Hibernate the rest of the time, running `prevent-lid-sleep.ps1`/`restore-lid-sleep.ps1` (both project-root scripts). The setting exists on this hardware (`powercfg /q`'s default output just hides it) — confirmed via the registry directly: `HKLM:\SYSTEM\CurrentControlSet\Control\Power\PowerSettings\4f971e89-eebd-4455-a8de-9e59040e7347\5ca83367-6e45-459f-a27b-476b1d01c936` is "Lid close action" (0=Do nothing, 1=Sleep, 2=Hibernate, 3=Shut down), settable directly via `powercfg /setacvalueindex`/`/setdcvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 <index>` + `/setactive SCHEME_CURRENT`, even though it's hidden from the CLI's own query output. Both tasks are `LogonType=S4U` + `RunLevel=Highest` — that combination self-elevates silently with no UAC prompt (confirmed live: triggered from a non-elevated session, still successfully wrote to `HKLM`), which only works for non-interactive-logon tasks; an Interactive-logon task with `RunLevel=Highest` would prompt for UAC consent instead. XML backups in `.task-xml/`.

**Correction, 2026-08-21**: the lid-close fix wasn't the whole story either. `WebullDailyReview`'s 1:15pm trigger *and* `WebullRestoreLidSleep`'s 1:30pm trigger were both missed the same day, both catch-ups failing at the identical timestamp (2:25:31pm) with the same `0x800710E0`. Event log (506/507) showed the laptop entered Modern Standby at 12:16pm with **`Reason: Idle Timeout`** — lid never closed — and didn't wake until 2:25pm via lid. Root cause: this machine's plain sleep-after-inactivity setting (`STANDBYIDLE`, `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`) was 180 seconds (3 min) on both AC/DC, completely independent of the lid-close-action setting the prior fix touched. Fixed by adding `powercfg /change standby-timeout-ac 0` / `-dc 0` to `prevent-lid-sleep.ps1` (and restoring to `3` in `restore-lid-sleep.ps1`, this machine's original value) — same prevent/restore pairing, just covering the second, independent sleep trigger. Also discovered live while fixing this: the restore task's failure that day left the lid-close override stuck in "prevented" state for over an hour past its 1:30pm restore time (caught and manually restored 2026-08-21 ~2:32pm) — worth spot-checking `AC=1 DC=2` on `SUB_BUTTONS`/`5ca83367...` after any missed-trigger day.

**Root-caused and fixed properly, 2026-08-24**: a whole trading day (Monday) was lost — every one of the four tasks (`WebullPreventLidSleep` 5:45am through `WebullDailyReview` 1:15pm) missed its trigger, and this time none of them even attempted a catch-up (no error, just silence — worse than the earlier `0x800710E0` cases). Event log showed the laptop entered sleep at 5:29am (`Sleep Reason: Button or Lid`, confirmed by the user — the lid was physically closed) and didn't wake until 7:41pm, 16 minutes before `WebullPreventLidSleep`'s own 5:45am trigger could ever run. This is the fundamental flaw in the whole prevent/restore approach: it depends on the machine already being awake at trigger time to defend against it going to sleep, so an early lid-close simply wins the race every time. **Real fix**: enabled Task Scheduler's `WakeToRun` setting on all five tasks (`WebullPreventLidSleep`, `WebullRestoreLidSleep`, `WebullWatchlistScreener`, `WebullAgentStart`, `WebullDailyReview`) — this proactively wakes the machine from sleep AT the trigger time (a real OS feature for exactly this, distinct from and more reliable than the passive "missed trigger, catch up whenever next possible" mechanism that kept failing). Required two changes: (1) `Set-ScheduledTask` with `.Settings.WakeToRun = $true` needs elevation (`Access is denied` non-elevated, same as any Settings/Principal change to these tasks) — done from an elevated PowerShell per-task; (2) wake timers must be allowed by the power scheme itself (`powercfg /query SCHEME_CURRENT SUB_SLEEP bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d`, "Allow wake timers") — this machine already had it on AC but **not** DC (battery), fixed via `powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d 1` (no elevation needed for this one). XML backups in `.task-xml/` re-exported from live state afterward to stay in sync (`schtasks /Query /TN <name> /XML`) — each now shows `<WakeToRun>true</WakeToRun>`. Tradeoff worth knowing: the laptop will now physically wake itself unattended at each trigger time even from battery, which costs some battery/does draw power briefly — acceptable given the alternative is silently losing an entire trading day.

## Remote hosting (GitHub Actions) — screener + agent, 2026-08-25/26

After losing two full trading days (2026-08-24, 2026-08-25) despite S4U,
lid/idle sleep prevention, AND `WakeToRun` (see Scheduling above — and it
happened again on 2026-08-26 for `WebullDailyReview` specifically, see
below), the screener + trading agent moved off this laptop entirely.
`WebullAgentStart` and `WebullWatchlistScreener` are now **disabled** (not
deleted — `schtasks /Change /TN <name> /DISABLE`, reversible via `/ENABLE`)
as of 2026-08-26, confirmed after one clean live cloud run. Do not
re-enable both this AND leave the GitHub Actions workflow active at the
same time — that would double-place every trade on the same sandbox
account.

**Laptop's original sleep behavior restored, 2026-08-28**: with the agent
+ screener no longer needing this machine awake all day, `WebullPreventLidSleep`
and `WebullRestoreLidSleep` are now **disabled** too (same reversible
`/DISABLE`, needed elevation since both run with `RunLevel=Highest`) —
they served no purpose once nothing local needed protecting from sleep for
hours at a stretch. Lid-close-action and idle-timeout-to-sleep
(`STANDBYIDLE`) were already sitting at their original values (AC=Sleep/
DC=Hibernate, 3-minute idle timeout) at the time, outside the old
trading-hours window, so no registry values needed changing — just
stopping the tasks that would have re-disabled sleep again the next
weekday morning. Left AS-IS, deliberately: "Allow wake timers" on DC
(battery), enabled back on 2026-08-24 — reverting it would work against
`WebullDailyReview`'s `WakeToRun` (still the one task that actually needs
this machine to wake itself, even if not yet proven reliable — see the
2026-08-26 caveat below). Net effect: this laptop can now sleep normally
again; `WebullDailyReview` is the only remaining task depending on it
waking up on schedule, with the same reliability caveats as before.

- **Repo**: `https://github.com/Pedrazar/webull-agent` (private). `gh` CLI
  is installed and authenticated as `Pedrazar` on this machine.
- **Workflow**: `.github/workflows/agent.yml` — three redundant cron
  triggers (13:17, 13:47, 14:17 UTC weekdays, see the 2026-08-27 incident
  below for why three off-the-hour slots instead of one on-the-hour one),
  all safely before 9:30am ET in both EDT and EST, plus `workflow_dispatch`
  for manual runs. A `concurrency` block prevents any two from actually
  running a session in parallel. `permissions: contents: write`,
  `timeout-minutes: 350` (margin under the 360-min hosted-runner hard cap —
  the 9:30am-3:30pm ET session is 6 hours since the EOD-close change
  above).
- **No DST-dependent dual-cron trickery**: rather than two seasonal cron
  triggers, `main.ts` gates itself on real `America/New_York` time
  (`nyNow()`, same DST-safe `Intl` pattern the EOD check already used) —
  `exitIfPastClose()` exits immediately if started already past 3:30pm ET
  (a stale/late trigger — also the safe zero-risk way to smoke-test the
  workflow's plumbing), and `waitForMarketOpen()` polls every 30s until
  9:30am ET before reconciling/connecting. The job can start up to ~90 min
  early without doing anything real.
- **Screener runs in-process now**, not as a separate scheduled job:
  `stockScreener.ts`'s `runScreener(client?)` is exported and called
  directly by `main.ts` (`loadOrRunScreener()`) at startup and on the
  hourly recheck, falling back to whatever's already in `watchlist.json`
  (then `MSTZ`) if the live run fails or finds nothing. Removes the
  cross-process dependency the old two-Windows-tasks setup had.
- **Bounded job, not always-on**: after `closeAllEndOfDay()` + one final
  `checkForFills()`, `main.ts` calls `stream.disconnect()` then
  `process.exit(0)` — the process now finishes on its own instead of
  running until killed, which is what makes it fit as a single Actions job.
- **Persistence**: `trades.jsonl`, `watchlist.json`, and `daily-notes.jsonl`
  are now **intentionally git-tracked** (see `.gitignore`'s comment), since
  the Actions filesystem is ephemeral per run. The workflow's final step
  commits + pushes them (`if: always()`, so a partial/failed day's data
  still isn't lost) — `git diff --cached --quiet` before committing means
  a no-trades day (like 2026-08-26, see below) correctly produces no
  commit at all, not an empty one.
- **Deliberately out of scope**: the production "Gap up" watchlist push
  (`pushToGapUpWatchlist` in `stockScreener.ts`) is NOT wired up in Actions
  — `WEBULL_PROD_APP_KEY`/`SECRET` were never added as repo secrets, so it
  silently no-ops every run exactly like it already did when those env
  vars were unset locally. Keeps the cloud runner's credential footprint
  to sandbox-only.
- **Daily review stays local** (explicit choice, not yet revisited) — it's
  not time-critical the way missing a trading day is, and moving it to
  Actions would need a new Anthropic API key + per-token billing separate
  from the Claude Code subscription this project otherwise uses.
  `WebullDailyReview`/`WebullPreventLidSleep`/`WebullRestoreLidSleep` are
  unchanged and still enabled. **Caveat found immediately, 2026-08-26**:
  even with `WakeToRun` set (see Scheduling above), `WebullDailyReview`
  still missed its trigger that same day — the fix does not appear fully
  reliable on this hardware after all. Not yet re-diagnosed; if this
  keeps recurring, revisit whether review should move off this laptop too.
- **First live cloud run, 2026-08-26 (Wednesday)**: ran 13:43–19:25 UTC,
  gated correctly, watched `BULL, XXI, MSTZ, NVTS` all session, EOD close
  and commit-back both worked. Logged zero `LONG_ENTRY` signals all day —
  BUT this was not actually a clean quiet day, see the missed-crossover gap
  immediately below. This is still the run the local tasks were disabled
  after; the gap found afterward is a real, separate issue, not a reason to
  revert the cutover itself.

- **Fixed, 2026-08-27** (found the day before, user chose "leave it for
  now" initially, then revisited same-day after the separate cron-delay
  incident above): MSTZ had a genuine, valid EMA9/20 crossover right at
  9:30am ET/13:30 UTC (market open) on 2026-08-26 — 0.445% separation,
  well above the 0.3% `minSeparationPct` filter, confirmed by independently
  refetching the day's historical bars and replaying the exact crossover
  math offline. It never fired `LONG_ENTRY` live. Root cause:
  `seedSymbol()`'s historical-bar seeding (`signals.seed()` in
  `signalEngine.ts`) only accumulates EMA state — it does NOT run
  `onBarClose()`'s crossover-detection logic (`seed()` updates
  `ema9`/`ema20` but never touches `prevEma9`/`prevEma20`, so the
  `crossedUp`/`crossedDown` check on the first live bar after startup can
  never fire even if a real cross happened during the gap), so any
  crossover inside the 30-bar seed window before the live stream starts
  was silently absorbed with no log line and no signal, ever — worse the
  later the job actually started, which GitHub Actions' `schedule` event
  makes more likely than the old local Task Scheduler setup did.
  **Fix**: `seedSymbol()` now splits the fetched 30-bar history at today's
  9:30am ET open using `isAtOrAfterMarketOpen()` — bars from before the
  open still go through silent `seed()` (pure EMA warmup, no meaningful
  entry decision exists pre-open anyway); bars at-or-after the open are
  replayed one at a time through the REAL `signals.onBarClose()` path
  instead. Any `LONG_ENTRY` found this way is logged as a new
  `missed_entry` trade event (`tradeLogger.ts`) — symbol, the historical
  bar's own timestamp (`barTime`, not detection time), price, volume — and
  the daily review reports these explicitly (see `run-daily-review.ps1`).
  Deliberately **never auto-traded**, per the user's explicit call: a
  crossover caught minutes late means the intended entry price is already
  gone, so log-only, don't chase it at a stale/current price with a stop
  sized for the original setup. The "move the cron trigger earlier" half
  of the originally-agreed two-part fix was deliberately dropped — once
  the replay covers the actual gap regardless of how late the job starts
  (within the 30-bar/30-min lookback), moving the trigger earlier only
  adds GitHub Actions billable wait-minutes for a private repo without
  closing any gap the replay doesn't already close. CONFIRMED live against
  real current bars for MSTZ/NVTS/BULL before shipping (no crashes,
  correct pre-open/session split, `onBarClose()`'s pending-confirmation
  mechanism fired correctly mid-replay). **Known residual limit**: the
  historical fetch is a fixed `count=30` (30 minutes) — if a start is late
  enough that ALL 30 bars fall after 9:30am, there are zero pre-open bars
  left for `seed()`'s EMA warmup, so the replay has to warm up from
  scratch and won't evaluate real crossovers until ~20 bars into the
  replay itself. Not fixed (no real incident has hit this yet, and the
  three-slot cron fix above keeps typical delays well under 30 min) — a
  dynamic bar count scaled to how late the start is would close it if it
  ever comes up.

- **Whole day silently missed, 2026-08-27 (Thursday)** — a much more
  severe version of the same underlying issue as the 43-min-late gap
  above. The `"0 13 * * 1-5"` trigger fired **9.5 hours late** (13:00 UTC
  intended, 22:39 UTC actual, confirmed via `gh run list`/`gh run view
  --log`, not assumed) — by the time it ran, `exitIfPastClose()` correctly
  saw NY time 18:40 and no-op'd in 16 seconds. GitHub's own docs warn
  scheduled workflows can be delayed and specifically call out the top of
  the hour as a known high-load time to avoid — our trigger landed exactly
  on `:00`. **Fixed** in `.github/workflows/agent.yml`: moved off the hour
  (`:17`/`:47`) AND fanned out to three redundant slots across the
  pre-market window (13:17, 13:47, 14:17 UTC) instead of one, so a single
  delayed/dropped trigger doesn't cost the whole day. Made safe by a
  `concurrency: group: trading-agent-session, cancel-in-progress: false`
  block — a second trigger firing while a session is already running
  QUEUES instead of starting a parallel session (which would double-trade
  the same sandbox account); it just runs later and no-ops via
  `exitIfPastClose()` once its turn comes. Not yet proven to fully solve
  it (one bad day is one data point) — if a day still gets missed entirely
  despite three spread-out attempts, that points at a more systemic GitHub
  Actions scheduling problem for this repo, not just hour-boundary
  congestion, and would justify an external trigger (e.g. a third-party
  cron service calling the GitHub API's workflow-dispatch endpoint)
  instead of relying on GitHub's own `schedule` event at all.

- **Three-slot fix insufficient, whole day missed again, 2026-08-28
  (Friday)** — the exact "more systemic" scenario flagged above happened:
  ALL THREE redundant `schedule` slots fired late together (23:01, 23:12,
  23:33 UTC — confirmed via `gh run view --log`, each showing
  `[startup] already past today's 3:30 PM ET close`), not just one. This
  proves GitHub was deprioritizing this repo's scheduled workflows overall,
  not just congestion at a specific minute — spreading triggers across the
  hour doesn't fix a problem that affects the whole hour. Separately
  confirmed `workflow_dispatch` (manual/API-triggered runs) is NOT subject
  to this delay: a `gh workflow run agent.yml` at `2026-08-29T02:02:36Z`
  started within ~4 seconds. **Fixed** by adding an external trigger
  independent of GitHub's `schedule` event entirely: a GitHub fine-grained
  Personal Access Token (scoped to just this repo, `Actions: Read and
  write` permission — `Metadata: Read-only` is also mandatory and auto-
  required by GitHub) plus the free **cron-job.org** service configured to
  `POST` directly to
  `https://api.github.com/repos/Pedrazar/webull-agent/actions/workflows/agent.yml/dispatches`
  with headers `Authorization: Bearer <token>`, `Accept:
  application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and
  body `{"ref":"main"}`. Job schedule: Custom cron `15 6 * * 1-5`
  evaluated in the job's own `America/Los_Angeles` timezone — deliberately
  NOT converted to UTC/ET, exploiting the fact that US Eastern is always
  exactly 3 hours ahead of Pacific year-round (both observe DST on the
  same date), so 6:15am PT = 9:15am ET every weekday regardless of season
  with zero DST-conversion logic needed. A successful dispatch returns
  `204 No Content`; verified end-to-end live (test run showed up in `gh run
  list` as a real `workflow_dispatch` event, completed successfully).
  The three in-repo `schedule` cron slots in `agent.yml` were deliberately
  **left in place** as a harmless backup — the existing `concurrency:
  cancel-in-progress: false` block means a redundant/late `schedule` fire
  just queues and no-ops via `exitIfPastClose()` if cron-job.org's
  `workflow_dispatch` already ran the session for the day. cron-job.org is
  now the **primary** trigger; GitHub's own `schedule` event is known-
  unreliable for this repo and should not be trusted alone.
  - A Claude Code cloud-agent "scheduled routine" (`RemoteTrigger`/the
    `schedule` skill) was tried first, to avoid needing a third-party
    service or handing out a GitHub credential externally. Abandoned: it
    requires connecting a GitHub account to claude.ai's cloud-agent
    feature specifically, and the Claude GitHub App was only installed on
    an unrelated organization account (`tripleten-externships`), never on
    the personal `Pedrazar` account this private repo lives under — no
    accessible UI path was found to add it there. If this becomes possible
    later, it would remove the need for the PAT/cron-job.org combo.

- **First on-time full session exposed a 360-min hard-cap timeout bug,
  2026-08-31 (Monday)** — cron-job.org's 9:15am ET trigger worked exactly
  as designed (job started within seconds), which meant, for the first
  time, a session actually ran continuously from before market open all
  the way toward the scripted close instead of getting cut short early by
  a late `schedule` trigger. That exposed a math error baked into the
  original `timeout-minutes: 350` setting: it was sized against "the
  session is 9:30am-3:30pm ET = 6 hours" but never accounted for the
  pre-open wait time. 9:15am ET start + 15 min wait for 9:30am open + the
  9:30am-3:25pm ET session (355 min) + checkout/npm-ci/commit overhead
  totaled ~370 min — past even GitHub's hard 360-min hosted-runner cap,
  let alone the 350-min timeout. GitHub force-killed the job at 3:05pm ET,
  **20 minutes before its own EOD close ever ran** (confirmed via `gh run
  view --json jobs`: the `Run trading agent` step shows
  `"conclusion":"cancelled"`, `updated_at` exactly 350 min after
  `run_started_at`). Harmless that day only because the one open position
  (MSTZ) had already hit its hard stop and closed at 14:41 UTC, hours
  before the kill — on a day with a position still open at 3:05pm ET, this
  would have abandoned it mid-session with no scripted flatten, left
  riding only its resting broker-side stop order overnight instead of the
  deliberate EOD close. The `if: always()` commit-back step still ran and
  captured `trades.jsonl` correctly even under a GitHub-forced kill, so no
  data was lost — only the EOD-close logic itself never got to run.
  **Fixed** two ways: (1) EOD close moved from 3:25pm to 3:15pm ET in
  `main.ts`, trimming the session to 345 min; (2) the cron-job.org trigger
  needs to move from 6:15am PT (9:15am ET) to **6:29am PT (9:29am ET)**,
  cutting the pre-open wait from 15 min to ~1 min — this is a config
  change on cron-job.org's own dashboard, not something committable here.
  With both fixes the real requirement drops to ~349 min; `timeout-minutes`
  bumped from 350 to 355 as our own buffer, still comfortably under the
  360-min hard cap. **Verified live 2026-09-01**: trigger fired at 9:29am
  ET, session ran the full 5h46m, EOD close fired cleanly at 3:15pm ET
  with no forced kill.

- **Queued backup `schedule` run slipped past both EOD guards,
  2026-09-01 (Tuesday)** — same day the timeout fix above was confirmed
  clean, one of the three redundant `schedule` slots fired late (as
  usual), queued behind the `concurrency` lock, and started only once the
  primary session's EOD close had already run — landing at 3:15:35pm ET,
  a few seconds after the exact `:15` minute mark. That's the one gap
  neither guard covered: `exitIfPastClose()` only trips past 3:30pm ET,
  and the EOD-close `setInterval` used an *exact* `minute === 15` match,
  which this run had already sailed past by the time its first tick fired.
  It proceeded through reconcile/seed and was about to connect to the live
  stream — a real crossover during that window could have placed a
  duplicate entry against a position the primary session had already
  closed. Attempted to stop it via `gh run cancel` at ~19:15 UTC once
  caught. **Fixed** in `main.ts`: added `isPastEodCloseTime()` (an "at or
  after 3:15pm ET" check, same pattern as `isAtOrAfterMarketOpen()`), used
  both in the `setInterval` (replacing the exact-minute match) and as a
  new guard checked once right after seeding — *before* the stream ever
  connects — so a late-starting process closes out and exits immediately
  without ever going live, instead of racing the clock through a live
  tick window.
  - **Correction, same day**: the original write-up here said "confirmed
    via `trades.jsonl` that no duplicate entry landed" — that was wrong,
    caught only by chance a few hours later when a routine "did we flatten
    everything" position check turned up a live MSTZ position that
    shouldn't exist. What actually happened: **`gh run cancel` does not
    reliably stop a running job** — it only *requests* a stop. This run
    kept executing on the old pre-fix code (already checked out before the
    fix above was pushed) for **4h13m** after the cancel request, placed a
    real live entry at 19:55 UTC (MSTZ, 300sh @ 5.41, stop @ 5.26), and
    was only actually force-killed by GitHub at 23:28 UTC, mid-`git
    rebase` in its own commit step — which then failed, so that
    `entry_placed` never reached `trades.jsonl` at all. The position is
    real on the broker's side; the log simply doesn't know about it (see
    `daily-notes.jsonl`, 2026-09-01, for the full incident note). Decision
    made with the user: left open overnight rather than force a flatten —
    it's still protected by its own resting stop, and tomorrow's regular
    session's `reconcile()` is the same proven path already used for any
    restart-with-open-position case. **Takeaway for next time**: `gh run
    cancel` is not a safe emergency stop for a live trading job by itself
    — always verify with a real broker-side positions/orders check (like
    `checkPositions.ts`) after cancelling, don't just trust
    `trades.jsonl` or the run's reported status.

## EOD close: known-fixed bug + a real remaining gap

First live (paper) day, 2026-08-19: the scheduled 3:55pm ET `closeAllEndOfDay()` failed for both open positions (PSNL, MRVI). Root cause, now fixed in `orderManager.ts` (`closeOneEndOfDay` + per-position try/catch in `closeAllEndOfDay`):
- **The bug**: cancelling a position's stop order and immediately placing the flattening `MARKET` sell raced the broker's own bookkeeping — the cancel returned success, but the sell was rejected (`OAUTH_OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION`, "will reverse an existing position") because the cancelled order's shares hadn't been released back to "available to sell" yet. Fixed by polling the cancel to a terminal state (`pollOrderFill`) before placing the sell.
- **The compounding bug**: the whole `for` loop had no per-position error isolation, so the first symbol's failure silently aborted every position after it in iteration order. Fixed by moving each position's close into `closeOneEndOfDay()` and wrapping each call in the loop.
- **Still open, a real gap, not yet solved in `orderManager.ts` itself**: `closeAllEndOfDay()` only ever places `MARKET` orders. Verified live that Webull rejects `MARKET` orders placed after regular hours (`OAUTH_OPENAPI_CAN_NOT_TRADING_FOR_FIXGW_NOT_READY_MARKET`, "Only limit orders are supported for extended-hours trading"). The 3:55pm ET trigger is 5 minutes before the 4:00pm ET close, so this is normally a non-issue — but if the close is ever missed or retried late (as happened today), there is currently no extended-hours fallback wired into `closeAllEndOfDay()` itself.
  - `closeAfterHours.ts` (new, 2026-08-19) is a standalone one-off that does this: LIMIT sell at `last_price` minus a small cent buffer, CONFIRMED live to require `order_type: "LIMIT"` + `time_in_force: "GTC"` + `extended_hours_trading: true` on the order object — a plain `DAY` LIMIT order is rejected after hours too (`OAUTH_OPENAPI_DAY_ORDER_NOT_ALLOWED_AFT_CORE_TIME_LIMIT`, which explicitly suggests GTC in its own error message). Orders placed this way land as genuine resting `SUBMITTED` orders, not rejected — but did NOT fill same-day in testing: the sandbox does not appear to simulate any real extended-hours price/tick movement (`last_price` on the position was static across repeated checks after hours), so there's nothing for a marketable limit order to match against until real trading resumes. Expect GTC orders placed after-hours to fill at/near the next session's open rather than immediately.
  - Also worth knowing: **the OpenAPI sandbox account is entirely separate from Webull's own consumer-app "paper trading" feature.** They don't share positions or orders — a position opened via this codebase's sandbox API keys will not appear (and cannot be closed) in the regular Webull app's paper trading UI; attempting to sell there produces a spurious "this order will generate new short stock positions" error, since that account never actually held the shares.

## Remaining gaps before this touches real money

From the original build-order plan, still open: MQTT bar/topic payload shape was confirmed empirically rather than from a written spec (worth re-checking against official docs if behavior ever seems off), and this has only ever been paper-traded — the README's original recommendation of several weeks of paper trading before real capital still stands. Production credentials exist now, but *only* for the watchlist push; no order-placement code path has ever been pointed at production, and doing so would need the same live re-verification treatment every sandbox-confirmed endpoint already got.
