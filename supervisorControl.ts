/**
 * Pause switch from the supervisor (Pedrazar/webull-supervisor, phase 2).
 *
 * Before opening a NEW position, an agent asks `supervisorPause(agentId)`.
 * The supervisor's control.json says, per agent, whether new entries are
 * paused. A pause never stops an agent from managing or closing what it
 * already holds: exits, stops and EOD closes ignore this file entirely.
 *
 * Fail-safe rules:
 *  - control.json unreachable on the first read -> NOT paused (the agent's
 *    own built-in limits still apply). A broken supervisor never stops trading.
 *  - unreachable later in the same process -> the last mode read is kept, so
 *    a network blip never unpauses a paused agent mid-session.
 *
 * This file is identical in all four agent repos; the source of truth is
 * webull-supervisor/agent-snippet/supervisorControl.ts.
 */

const API_URL = "https://api.github.com/repos/Pedrazar/webull-supervisor/contents/control.json";
const RAW_URL = "https://raw.githubusercontent.com/Pedrazar/webull-supervisor/main/control.json";
const CACHE_MS = 60_000;

export interface PauseStatus {
  paused: boolean;
  reason?: string;
  /** "control" = read just now, "cached" = within the last minute, "last-known" = read failed, using the previous answer, "default" = never read. */
  source: "control" | "cached" | "last-known" | "default";
}

interface ControlEntry {
  mode?: "run" | "paused";
  reason?: string;
  /** NY date (YYYY-MM-DD) the pause applies to. Absent = until resumed. */
  date?: string;
}

let last: { at: number; status: PauseStatus } | null = null;

export async function supervisorPause(agentId: string): Promise<PauseStatus> {
  if (last && Date.now() - last.at < CACHE_MS) return { ...last.status, source: "cached" };
  try {
    const control = await fetchControl();
    const entry: ControlEntry | undefined = control?.agents?.[agentId];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const paused = entry?.mode === "paused" && (!entry.date || entry.date === today);
    const status: PauseStatus = { paused, reason: paused ? entry?.reason ?? "paused by supervisor" : undefined, source: "control" };
    last = { at: Date.now(), status };
    return status;
  } catch (err) {
    console.warn(`[supervisor] couldn't read control.json (${String(err).slice(0, 120)}), ${last ? "keeping the last mode" : "not paused"}`);
    return last ? { ...last.status, source: "last-known" } : { paused: false, source: "default" };
  }
}

async function fetchControl(): Promise<{ agents?: Record<string, ControlEntry> }> {
  const token = process.env.GITHUB_TOKEN;
  // The API is uncached (a pause takes effect within a minute); raw.githubusercontent.com
  // is the fallback but its CDN can serve a copy up to ~5 min old.
  const tries: Array<[string, Record<string, string>]> = [
    [API_URL, { Accept: "application/vnd.github.raw+json", "User-Agent": "webull-agent", ...(token ? { Authorization: `Bearer ${token}` } : {}) }],
    [RAW_URL, { "User-Agent": "webull-agent" }],
  ];
  let lastErr: unknown;
  for (const [url, headers] of tries) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return {}; // no control file yet = nothing paused
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as { agents?: Record<string, ControlEntry> };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
