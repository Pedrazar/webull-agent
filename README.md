# Webull Live Trading Agent — TypeScript Scaffold

This is a starting scaffold for running your EMA-9/EMA-20 crossover strategy
live against Webull's OpenAPI, since no official SDK exists for Node/TypeScript
(only Python and Java are officially supported).

## Files

- `webullClient.ts` — signed REST client (GET/POST helpers)
- `marketDataStream.ts` — MQTT live bar feed with reconnect + resubscribe
- `signalEngine.ts` — incremental EMA-9/20 crossover, with historical seeding
- `orderManager.ts` — hard-stop → breakeven → trailing-stop state machine,
  using native Webull combo/trailing orders where possible, plus a kill switch
- `main.ts` — wires it all together

## Signature algorithm — VERIFIED (2026-08-16)

`webullClient.ts` now implements the real algorithm, ported directly from the
official Python SDK source (`webull-openapi-python-sdk`):
`core/auth/composer/default_signature_composer.py`,
`core/auth/algorithm/sha_hmac256_new.py`, and `core/headers.py`.

Key facts confirmed from source, including one that contradicts the docs'
labeling:

- **It's actually HMAC-SHA256, not SHA-1** — despite the module being named
  `sha_hmac1` and the SDK importing it as the default, `_refresh_sign_headers()`
  unconditionally overrides the signer to `sha_hmac256_new` before use. Every
  real request the SDK sends is signed with SHA-256.
- Digest is **base64-encoded**, not hex.
- The secret used for HMAC has a **trailing `&` appended** before signing.
- The canonical string is `uri&sorted_key=value&...&BODY_HASH`, where the
  body hash (if a body exists) is SHA-256 hex, uppercased.
- The whole canonical string is percent-encoded matching Python's
  `quote(s, safe='')` — encodes `/` too, and additionally encodes `! * ' ( )`
  which plain `encodeURIComponent` leaves alone (`pythonQuote()` patches this).
- `host` participates in the signature as a lowercase `host` param but is
  **never sent as an actual request header** — it's added to the sign-params
  dict after the real headers are already set.

**Still worth a quick empirical check before going live:** the exact string
format of `common.get_iso_8601_date()` (Python's helper) wasn't inspected
directly — `isoTimestamp()` assumes standard `YYYY-MM-DDTHH:mm:ssZ` format
(no milliseconds). If a sandbox request gets a timestamp-related auth error,
this is the first place to check — try with and without milliseconds.

## Before this touches real money — remaining gaps to close

1. ~~Signature algorithm~~ — done, see above. Still validate against the
   sandbox before trusting it: a signed request either authenticates or it
   doesn't, and that's the real proof, not code review.

2. **MQTT auth scheme.** The `username`/`password` fields in
   `marketDataStream.ts` are placeholders for however Webull's MQTT broker
   actually authenticates connections (likely app key + a signed/derived
   token, but confirm from the Data Streaming API manual-integration section).

3. **Bar/topic payload shape.** The parsing in `handleMessage()` assumes a
   flat JSON shape with `time/open/high/low/close/volume` fields and a
   slash-delimited topic — confirm both against the manual integration docs
   or by logging a raw message once connected.

4. **Endpoint paths.** Paths like `/openapi/trade/stock/combo-order` and
   `/openapi/market-data/stock/history-bar` are inferred from doc examples,
   not copied verbatim from a full API reference table — cross-check each
   against the API Reference before wiring live.

5. **EOD timezone.** `main.ts` hardcodes 19:55 UTC for a 3:55 PM ET close —
   this breaks across the EST/EDT boundary. Compute the offset dynamically
   (e.g. with a timezone-aware library) rather than hardcoding, especially
   since this is the exact bug you're already chasing in the Script Editor.

## Suggested build order

1. Get a request authenticating successfully against `api.sandbox.webull.com`
   with the shared test credentials — this validates the signature function.
2. Get one MQTT message flowing and logged raw, before writing any parsing
   logic against assumed field names.
3. Run `signalEngine.ts` against your existing backtested historical bars
   and confirm it reproduces the same crossover signals as your Script Editor
   version — this is your regression check before trusting it live.
4. Paper-trade the full pipeline for at least a few weeks per the original
   build-order recommendation, before real capital touches it.

## Install

```bash
npm install mqtt
```

Node 18+ is assumed for native `fetch`.
