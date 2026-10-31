import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Database availability probe for the external uptime monitor (GET /api/health/db). SERVER-ONLY.
 *
 * Why it exists: on 2026-10-30/31 Production could not reach its database for ~40 hours while /api/health
 * (static) and the page-latency monitor stayed green. This probe answers whether the two connections the app
 * actually serves traffic through can run a query right now:
 *   - runtime: the canonical tenant client (DATABASE_URL);
 *   - auth:    the client login / session resolution use (authDb(): AUTH_DATABASE_URL when the auth plane is
 *              active, the runtime client in legacy mode).
 *
 * What it runs: `SELECT 1` on each, in parallel — no table, no lock, no write, no tenant data. Each check has its
 * own timeout and the whole probe has a hard deadline, so a hung connection can never hold the monitor.
 *
 * Who may call it: only a caller holding HEALTH_MONITOR_SECRET (Bearer). FAIL CLOSED and decided before any
 * database work: no secret configured (or shorter than 32, or equal to CRON_SECRET) → 503 not_configured; a wrong
 * or missing credential → 401. Neither path touches the database, so an anonymous caller cannot use the route to
 * wake or load it.
 *
 * What it answers: fixed codes only — never an error message, host, role or connection string. The full error
 * stays out of the response; the log carries its class and machine code (safeErrorSummary) and nothing else.
 *
 * Never cached: every answer carries no-store for the browser, the CDN and Vercel's CDN, so no layer can replay an
 * earlier "ok" while the database is down.
 */

export const MIN_MONITOR_SECRET_LENGTH = 32;
/** One check's budget. Cold function + a Neon compute waking from suspend fits well inside it. */
export const CHECK_TIMEOUT_MS = 3000;
/** The whole probe's budget (the two checks run in parallel; this caps the slower one plus overhead). */
export const PROBE_DEADLINE_MS = 4500;

export type MonitorAuthDecision = "AUTHORIZED" | "UNAUTHORIZED" | "NOT_CONFIGURED";

/**
 * Constant-time Bearer check against the monitor's own secret. The secret is dedicated: when it equals CRON_SECRET
 * it is treated as not configured, so the monitor's credential (held by a third-party service) can never trigger a
 * sweep, and a leaked cron credential can never be mistaken for a monitor one.
 */
export function decideMonitorAuth(
  authorizationHeader: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>
): MonitorAuthDecision {
  const secret = (env.HEALTH_MONITOR_SECRET ?? "").trim();
  if (secret.length < MIN_MONITOR_SECRET_LENGTH) return "NOT_CONFIGURED";
  if (secret === (env.CRON_SECRET ?? "").trim()) return "NOT_CONFIGURED";
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? "").trim());
  if (!match) return "UNAUTHORIZED";
  const a = createHash("sha256").update(match[1].trim()).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b) ? "AUTHORIZED" : "UNAUTHORIZED";
}

/** The only failure codes the probe ever answers. */
export type CheckFailure = "unreachable" | "timeout" | "rejected" | "not_configured" | "error";
export type CheckResult = { ok: true; ms: number } | { ok: false; ms: number; code: CheckFailure; cause: unknown };

/**
 * One check: a function that sends `SELECT 1` on one connection (the route passes `() => prisma.$queryRaw`SELECT 1``).
 * The client never leaves the route; this module only times and classifies what the function does.
 */
export type Ping = () => Promise<unknown>;

const UNREACHABLE = new Set(["P1001", "P1002", "P1017", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);
const REJECTED = new Set(["P1000", "P1003", "P1010", "28P01", "28000", "3D000", "53300"]);

/**
 * Prisma 6 often raises PrismaClientInitializationError WITHOUT an errorCode, so its wording is matched against
 * fixed patterns. The message is only tested here — it is never returned or logged.
 */
const REJECTED_TEXT = /denied access|authentication failed|password authentication|role .* does not exist|database .* does not exist|too many (connections|clients)/i;
const UNREACHABLE_TEXT = /can't reach database server|connection refused|closed the connection|timed out|could not connect|quota/i;

/** Error → fixed code. Prisma's codes first, then the driver's, then the known wording; unknown → "error". */
export function classifyFailure(error: unknown): CheckFailure {
  if (!(error instanceof Error)) return "error";
  const code = (error as { code?: unknown; errorCode?: unknown }).errorCode ?? (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (UNREACHABLE.has(code)) return "unreachable";
    if (REJECTED.has(code)) return "rejected";
  }
  if (REJECTED_TEXT.test(error.message)) return "rejected";
  if (UNREACHABLE_TEXT.test(error.message)) return "unreachable";
  if (error.name === "PrismaClientInitializationError") return "unreachable";
  return "error";
}

class CheckTimeout extends Error {
  constructor() {
    super("check timed out");
    this.name = "CheckTimeout";
  }
}

/**
 * Runs one ping within `timeoutMs`. A ping that throws before it returns a promise could not even build its client
 * (the auth client throws when AUTH_DATABASE_URL is absent in active mode) → not_configured, never an escape.
 * A query still in flight at the timeout is abandoned, not awaited.
 */
export async function runCheck(ping: Ping, timeoutMs = CHECK_TIMEOUT_MS, now: () => number = Date.now): Promise<CheckResult> {
  const started = now();
  let pending: Promise<unknown>;
  try {
    pending = ping();
  } catch (cause) {
    return { ok: false, ms: now() - started, code: "not_configured", cause };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
      }),
    ]);
    return { ok: true, ms: now() - started };
  } catch (cause) {
    return { ok: false, ms: now() - started, code: cause instanceof CheckTimeout ? "timeout" : classifyFailure(cause), cause };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ProbeReport = {
  status: "ok" | "down";
  checks: { runtime: "ok" | CheckFailure; auth: "ok" | CheckFailure };
  ms: { runtime: number; auth: number };
  checkedAt: string;
};

/**
 * Both checks in parallel under one deadline. A check that has not settled by the deadline counts as "timeout"
 * (belt and braces: each check already stops at its own timeout).
 */
export async function probeDatabases(
  pings: { runtime: Ping; auth: Ping },
  opts: { checkTimeoutMs?: number; deadlineMs?: number; now?: () => number } = {}
): Promise<{ report: ProbeReport; failures: Array<{ check: "runtime" | "auth"; cause: unknown }> }> {
  const now = opts.now ?? Date.now;
  const checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? PROBE_DEADLINE_MS;
  const started = now();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const capped = (p: Promise<CheckResult>) =>
    Promise.race([
      p,
      new Promise<CheckResult>((resolve) => {
        timers.push(setTimeout(() => resolve({ ok: false, ms: now() - started, code: "timeout", cause: new CheckTimeout() }), deadlineMs));
      }),
    ]);
  try {
    const [runtime, auth] = await Promise.all([
      capped(runCheck(pings.runtime, checkTimeoutMs, now)),
      capped(runCheck(pings.auth, checkTimeoutMs, now)),
    ]);
    const failures: Array<{ check: "runtime" | "auth"; cause: unknown }> = [];
    if (!runtime.ok) failures.push({ check: "runtime", cause: runtime.cause });
    if (!auth.ok) failures.push({ check: "auth", cause: auth.cause });
    return {
      report: {
        status: runtime.ok && auth.ok ? "ok" : "down",
        checks: { runtime: runtime.ok ? "ok" : runtime.code, auth: auth.ok ? "ok" : auth.code },
        ms: { runtime: runtime.ms, auth: auth.ms },
        checkedAt: new Date(now()).toISOString(),
      },
      failures,
    };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

/** Headers on EVERY answer of the route (200, 401, 503): nothing may be stored by the browser, a proxy or the CDN. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate, private",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex",
};
