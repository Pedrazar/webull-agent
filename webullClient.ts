/**
 * Webull OpenAPI REST client — Node/TypeScript, no official SDK exists for this
 * language, so this talks to the raw HTTP endpoints directly.
 *
 * Signature algorithm below was reverse-engineered directly from the official
 * Python SDK source (webull-openapi-python-sdk), specifically:
 *   - webull/core/auth/composer/default_signature_composer.py  (calc_signature)
 *   - webull/core/auth/algorithm/sha_hmac256_new.py             (get_sign_string)
 *   - webull/core/headers.py                                    (exact header names)
 *
 * IMPORTANT: despite the module being named "sha_hmac1" and the SDK importing
 * it by default, `_refresh_sign_headers()` unconditionally overrides the signer
 * to `sha_hmac256_new` — so the SDK always signs with HMAC-SHA256, base64-encoded,
 * regardless of what's configured. This code matches that actual behavior.
 */

import crypto from "crypto";

export interface WebullConfig {
  appKey: string;
  appSecret: string;
  baseUrl: string; // e.g. "https://api.webull.com" (prod) or sandbox host
  host: string; // bare hostname used ONLY in signing, e.g. "api.webull.com" — not sent as a header
  accessToken?: string;
}

// ISO 8601 UTC, matching Python's typical get_iso_8601_date() output
function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Mirrors Python's `quote(string, safe='')` exactly. encodeURIComponent alone
 * is NOT equivalent — Python additionally percent-encodes ! * ' ( ) which
 * encodeURIComponent leaves untouched, so those must be patched in.
 */
function pythonQuote(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Compact JSON, matching Python's json.dumps(obj, separators=(',', ':')) */
function compactJson(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function sha256HexUpper(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").toUpperCase();
}

interface SignResult {
  headers: Record<string, string>;
  signature: string;
}

/**
 * Direct port of calc_signature() from default_signature_composer.py.
 *
 * @param uri    the request path only, e.g. "/openapi/trade/stock/order" — NOT
 *               including scheme/host/query string
 * @param query  query params as a plain object (only used for GET-style calls;
 *               pass {} for POST-with-body calls where params travel in the body)
 * @param body   parsed body object, or undefined/null if there is no body
 */
function calcSignature(
  host: string,
  uri: string,
  query: Record<string, string>,
  body: Record<string, unknown> | undefined,
  appKey: string,
  appSecret: string
): SignResult {
  // 1. Build sign headers (these get sent AS headers too, except host)
  const signHeaders: Record<string, string> = {
    "x-app-key": appKey,
    "x-timestamp": isoTimestamp(),
    "x-signature-version": "1.0",
    "x-signature-algorithm": "HMAC-SHA256",
    "x-signature-nonce": uuid(),
  };

  const headersToSend = { ...signHeaders };

  // host is added to the sign params AFTER headers.update() in the Python code —
  // meaning it participates in the signature but is never sent as a request header
  const signParams: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(signHeaders).map(([k, v]) => [k.toLowerCase(), v])
    ),
    host: host,
  };

  // 2. Merge in query params (original casing preserved, per the SDK)
  for (const [k, v] of Object.entries(query)) {
    if (signParams[k] !== undefined) {
      signParams[k] = `${signParams[k]}&${v}`;
    } else {
      signParams[k] = v;
    }
  }

  // 3. Body hash: compact JSON -> SHA-256 hex -> uppercase
  let bodyString: string | null = null;
  if (body !== undefined && body !== null) {
    bodyString = sha256HexUpper(compactJson(body));
  }

  // 4. Build canonical string: uri&k1=v1&k2=v2...(&bodyHash), sorted by key
  const sortedKeys = Object.keys(signParams).sort(); // default JS sort = lexicographic, matches Python's sorted()
  const kvPairs = sortedKeys.map((k) => `${k}=${signParams[k]}`);

  let stringToSign = uri ? `${uri}&${kvPairs.join("&")}` : kvPairs.join("&");
  if (bodyString) {
    stringToSign = `${stringToSign}&${bodyString}`;
  }

  const encoded = pythonQuote(stringToSign);

  if (process.env.WEBULL_DEBUG_SIGN) {
    console.log("--- SIGN DEBUG ---");
    console.log("string_to_sign (raw):", stringToSign);
    console.log("string_to_sign (encoded):", encoded);
  }

  // 5. HMAC-SHA256, secret has a trailing '&' appended, digest is base64
  const signature = crypto
    .createHmac("sha256", appSecret + "&")
    .update(encoded, "utf8")
    .digest("base64");

  headersToSend["x-signature"] = signature;

  if (process.env.WEBULL_DEBUG_SIGN) {
    console.log("headers sent:", headersToSend);
    console.log("------------------");
  }

  return { headers: headersToSend, signature };
}

export class WebullClient {
  constructor(private config: WebullConfig) {}

  /** Attaches an access token obtained after construction (e.g. from the
   * production create/check/refresh token flow) — the config's own
   * accessToken field only covers the case where it's known up front. */
  setAccessToken(accessToken: string): void {
    this.config.accessToken = accessToken;
  }

  private buildHeaders(
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown> | undefined
  ): Record<string, string> {
    const { headers } = calcSignature(
      this.config.host,
      path,
      query,
      body,
      this.config.appKey,
      this.config.appSecret
    );

    headers["content-type"] = "application/json";
    headers["x-version"] = "v2";
    headers["x-webull-client-source"] = "sdk";
    if (this.config.accessToken) {
      headers["x-access-token"] = this.config.accessToken;
    }
    return headers;
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const headers = this.buildHeaders(path, params, undefined);
    const query = new URLSearchParams(params).toString();
    const url = `${this.config.baseUrl}${path}${query ? `?${query}` : ""}`;

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(`Webull GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return parseResponseBody<T>(res);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers = this.buildHeaders(path, {}, body);
    const url = `${this.config.baseUrl}${path}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      throw new Error(`Webull POST ${path} failed: ${res.status} ${await res.text()}`);
    }
    return parseResponseBody<T>(res);
  }
}

/**
 * CONFIRMED via live testing: some endpoints (e.g. the streaming subscribe
 * call) return HTTP 200 with a genuinely EMPTY body (Content-Length: 0) on
 * success — calling .json() unconditionally throws "Unexpected end of JSON
 * input" on these. This handles that case by returning an empty object
 * instead of crashing a call that actually succeeded.
 */
async function parseResponseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}
