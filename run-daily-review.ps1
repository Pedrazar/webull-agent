$ErrorActionPreference = "Stop"
Set-Location "C:\Users\pedra\projects\webull-agent"

Add-Type -AssemblyName System.Windows.Forms
$powerStatus = [System.Windows.Forms.SystemInformation]::PowerStatus
$batteryPct = [int]($powerStatus.BatteryLifePercent * 100)
if ($powerStatus.PowerLineStatus -eq "Offline" -and $batteryPct -lt 20) {
    Write-Output "[power] on battery at $batteryPct percent, below the 20 percent threshold - skipping this run"
    exit 0
}

# The GitHub Actions agent run is the only thing that ever writes trades.jsonl
# -- this laptop's working copy is just a clone, so without pulling first the
# review reads whatever was here as of its last manual pull. Confirmed live,
# 2026-09-10/11: two straight days of real trading activity got reviewed
# against a stale local trades.jsonl and reported as "no trading data" /
# a possible missed trigger, when the trades were real and just sitting
# unpulled on GitHub. `--ff-only` so a genuine conflict (e.g. uncommitted
# local edits) fails loudly instead of the review silently running on
# whatever state it finds.
git pull origin main --ff-only
if ($LASTEXITCODE -ne 0) {
    Write-Output "[git] pull failed - reviewing against local data as-is, but note this may be stale"
}

# Without this, PowerShell decodes claude.exe's UTF-8 stdout (em dashes,
# curly quotes, etc.) through the legacy console codepage instead, mangling
# any non-ASCII character (confirmed live: em dashes came out as "ΓÇö").
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# NOTE: this agent is Read/Glob/Grep only, deliberately with NO Write access.
# Headless (-p) mode has no one to approve a Write permission prompt, so an
# agent that tries to use the Write tool here just stalls describing what it
# would do instead of doing it (confirmed live, twice). Instead it's told to
# output the full report as its plain response text, and THIS SCRIPT saves
# that text to disk via PowerShell's own file write, which never goes
# through Claude's tool-permission system at all.
$prompt = @'
You are reviewing today's trading activity for an automated EMA-9/20
crossover trading agent running against Webull's sandbox (paper trading)
API. Your job is pure analysis and reporting. You must NOT modify any .ts
file (orderManager.ts, main.ts, stockScreener.ts, etc.) — only read data
files. You have no Write access in this session; do not attempt to use a
Write tool. Instead, output the entire report as the text of your reply.

Working directory: C:\Users\pedra\projects\webull-agent (already your cwd)

Files to read:
- trades.jsonl -- one JSON object per line, append-only trade event log.
  Event types:
  - entry_placed: {symbol, quantity, requestedPrice, filledPrice, stopPrice,
    volume} -- volume is the bar's volume at the moment this entry's
    signal fired, or null if unavailable.
  - entry_rejected: {symbol, reason ("price_out_of_range" |
    "kill_switch_active" | "already_in_position" | "spread_too_wide" |
    "quote_unavailable" | "symbol_on_cooldown" | "volume_too_low"), price,
    cooldownReason, volume}
    -- "symbol_on_cooldown" (added 2026-09-01) means the symbol just lost
    AGENT_COOLDOWN_STREAK times in a row (default 3) and is being skipped
    for AGENT_COOLDOWN_DAYS calendar days (default 2) from the last of
    those losses -- see cooldown.ts. cooldownReason is only present on
    this reason and already spells out the streak (e.g. a note like
    "3 consecutive losses" followed by each loss amount and a last-loss
    timestamp). "volume_too_low" (added 2026-09-03, after a real SID entry
    fired on a 100-share signal bar) means the triggering bar's volume was
    below AGENT_MIN_ENTRY_VOLUME (default 5,000) -- the volume field on
    this reason carries the actual (too-low) value. Always call both
    explicitly in their own sections ("Active cooldowns", "Volume-gate
    rejections" -- only if any exist for today), same treatment as
    missed_entry below -- these are the two places the agent adapts on its
    own rather than waiting for a human to change a hardcoded parameter
    place the agent adapts to its own losses, so it's worth surfacing
    plainly.
  - breakeven_move: {symbol, newStopPrice}
  - trailing_start: {symbol, trailingStopStep}
  - exit_filled: {symbol, exitReason ("HARD_STOP"|"BREAKEVEN"|"TRAILING"|
    "EOD"), entryPrice, exitPrice, quantity, realizedPnl, holdMinutes,
    volume} -- volume here is the most recently closed bar's volume as of
    when the fill was detected (exits are found by polling order status,
    not from a bar close directly, so treat this as "volume around the
    time of the exit," not the exact bar the fill executed in), or null if
    unavailable.
  - missed_entry: {symbol, barTime, price, volume} -- a genuine LONG_ENTRY
    crossover was found during startup's historical-bar catch-up replay
    (added 2026-08-27, after a real missed MSTZ crossover at market open
    caused by a late job start), but by the time it was detected the price
    was already stale, so it was deliberately NOT traded. barTime is the
    historical bar's own timestamp, not when this was detected -- if
    barTime is more than a few minutes before this trading day's first
    entry_placed/bar-log activity, that's how late the session actually
    started that day. Always call these out explicitly in the report (a
    separate "Missed entries" note, not folded into the metrics table) --
    this represents a real opportunity cost even though no trade exists to
    compute P&L from.
- watchlist.json -- the symbols the morning screener (stockScreener.ts)
  selected for today (criteria: market cap > $300M, price $1-$20, gap >=
  5%, avg volume > 1M, relative volume > 2, float > 20M).
- daily-notes.jsonl -- optional, append-only, one JSON object per line:
  {ts, date ("YYYY-MM-DD"), note}. Manually-added observations that
  wouldn't otherwise show up in trades.jsonl (e.g. a bug caused a missed
  exit that never got logged as a trade event, so the raw numbers alone
  would misread the day). If this file exists, filter to entries whose
  `date` matches today, and fold their content into the report as their
  own subsection ("Manual notes") — treat them as ground truth about what
  happened, not something to second-guess against trades.jsonl.

Task:
1. Filter trades.jsonl to today's date (compare the `ts` field's date
   portion to today's date).
2. Compute: entries placed, entries rejected (and why), exits by
   exitReason, win rate (realizedPnl > 0), total realized P&L, average
   winner, average loser, average hold time.
3. Identify what worked and what didn't, concretely -- e.g. "3 of 4 exits
   were HARD_STOP, meaning entries rarely reached the favorable move
   needed for breakeven" or "the one EOD exit lost money -- the position
   never resolved intraday." Ground every claim in the actual numbers in
   the log, don't speculate beyond what it shows. Include a per-trade
   breakdown table (entry ts, entry price+volume, exit ts, exit
   price+volume, exit reason, P&L, hold time) -- volume at entry vs. exit
   is specifically useful for spotting whether a trade fired on genuine
   participation or a thin, low-volume wiggle (relevant to the
   minSeparationPct flat-market filter in signalEngine.ts -- note if any
   losing trade shows conspicuously low entry volume relative to the
   day's other trades, since that's exactly the pattern that filter is
   meant to catch).
4. Suggest specific, concrete directions for parameter changes (e.g.
   hardStopAmount, breakevenActivationAmount, trailingActivationAmount,
   trailingStopAmount, minPrice/maxPrice, or the screener's thresholds)
   that the data supports -- but do NOT edit any source file yourself.
   These are recommendations for a human to review and apply deliberately
   in a future session, not something to self-apply. A single day of data
   is a small sample -- say so explicitly, and flag if the sample size is
   too small to draw a real conclusion.
5. Format your reply as the full markdown report: a one-paragraph summary
   at the top, a metrics table, then "What worked", "What didn't", a
   "Missed entries" section (only if any missed_entry events exist for
   today -- omit entirely otherwise), an "Active cooldowns" section (only
   if any symbol_on_cooldown rejections exist for today -- omit entirely
   otherwise; name the symbol and quote its cooldownReason field, which
   already has the losing streak spelled out), a "Volume-gate rejections"
   section (only if any volume_too_low rejections exist for today -- omit
   entirely otherwise; name the symbol and its volume field value against
   the AGENT_MIN_ENTRY_VOLUME threshold), a "Manual notes" section (only if
   daily-notes.jsonl has entries for today -- omit the section entirely
   otherwise), and "Suggested directions to consider". Output ONLY the
   report -- no preamble like "Here's my analysis," no closing remarks
   after it.
6. If trades.jsonl has no entry_placed/exit_filled/entry_rejected events
   for today, but DOES have one or more missed_entry events, don't call it
   "no trading activity" -- report it as a missed-entry day: no trades
   were placed, but a genuine crossover was found late (see the
   missed_entry field description above) and deliberately not chased.
   Only fall back to a short "no trading activity occurred" report if
   trades.jsonl doesn't exist yet or has no entries of ANY kind for today.

Keep the report factual and specific to today's numbers -- this is a data
summary for a human to act on, not a persuasive pitch.
'@

if (-not (Test-Path "daily-reviews")) {
    New-Item -ItemType Directory -Path "daily-reviews" | Out-Null
}

$date = Get-Date -Format "yyyy-MM-dd"
$runStamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$reportFile = "daily-reviews\$date.md"
$logFile = "daily-review-run-$runStamp.log"

$output = & "C:\Users\pedra\.local\bin\claude.exe" -p $prompt --allowedTools "Read,Glob,Grep" --model claude-sonnet-5 2>&1
$output | Out-File -FilePath $logFile -Encoding utf8
$output | Out-File -FilePath $reportFile -Encoding utf8
