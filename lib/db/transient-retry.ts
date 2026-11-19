/**
 * One bounded retry for a dropped database connection — and for nothing else.
 *
 * Why: in Production a warm function sometimes reuses a pooled connection the Neon pooler has already closed. The next
 * query fails with P1017 ("Server has closed the connection") or, during the reconnect, P1001 ("Can't reach database
 * server"); Prisma reconnects by itself on the following query. The schedulers recover on their own retry, but the run
 * answers 500 first. A single short in-process retry turns that into one green run.
 *
 * What is retried: ONLY an error that says the connection was not there — Prisma P1001 / P1002 / P1017, a pool that
 * could not hand out a connection (P2024), or Prisma's "can't reach" / "closed the connection" wording when the code is
 * missing. Never a constraint (P2002), a transaction timeout (P2028), a query error, a bug, or anything unknown.
 *
 * Where it may be used: only around work that is safe to run a second time — a read, or a step whose own guard (a
 * conditional claim, a lease, an idempotent key) makes a repeat a no-op. The caller decides that; this helper cannot.
 * Every call site says why its work is safe to repeat.
 *
 * Pure: no Prisma import, no database, no clock beyond the injected sleep.
 */

/** Prisma codes that mean "no usable connection" — the statement never ran on a live session. */
export const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set(["P1001", "P1002", "P1017", "P2024"]);

/** Prisma sometimes raises these without a code; the message is only tested here, never logged or returned. */
const CONNECTION_ERROR_TEXT = /can't reach database server|server has closed the connection/i;

export const RETRY_DEFAULTS = { attempts: 2, delayMs: 250 } as const;

/** The error says the database connection was missing or dropped (see the module header). */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as { code?: unknown; errorCode?: unknown };
  const code = typeof e.code === "string" ? e.code : typeof e.errorCode === "string" ? e.errorCode : null;
  if (code !== null) return CONNECTION_ERROR_CODES.has(code);
  return CONNECTION_ERROR_TEXT.test(error.message);
}

export type TransientRetryOptions = {
  /** Total attempts, including the first. Bounded to 1..3. */
  attempts?: number;
  /** Pause before each retry (ms). Bounded to 0..2000. */
  delayMs?: number;
  /** A short fixed label for the server log (route / step name). Never data. */
  label: string;
  /**
   * Asked after a connection error, before retrying: false keeps the error (e.g. the work already passed a step whose
   * result must not be lost silently). Default: always retry.
   */
  canRetry?: () => boolean;
  /**
   * Run once after a connection error, before the pause and the retry — e.g. evict the other dead pooled connections so
   * the retry does not draw one of them (lib/db/connection-recovery.ts). It must be safe to run at any time; whatever
   * it throws is ignored (the retry still happens and decides the outcome).
   */
  beforeRetry?: () => Promise<unknown>;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only. */
  log?: (line: string, meta: Record<string, unknown>) => void;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`; if it fails with a connection error and attempts remain, wait and run it again. Any other error, or the
 * last attempt's error, is thrown unchanged — the caller's own failure path still runs.
 */
export async function withConnectionRetry<T>(fn: (attempt: number) => Promise<T>, options: TransientRetryOptions): Promise<T> {
  const attempts = Math.min(3, Math.max(1, Math.floor(options.attempts ?? RETRY_DEFAULTS.attempts)));
  const delayMs = Math.min(2000, Math.max(0, options.delayMs ?? RETRY_DEFAULTS.delayMs));
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? ((line, meta) => console.warn(line, meta));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isConnectionError(error) || options.canRetry?.() === false) throw error;
      // Class and code only — never the message, which can carry the host.
      log("[db-retry] connection dropped, retrying", {
        label: options.label,
        attempt,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode ?? null,
      });
      if (options.beforeRetry) {
        try {
          await options.beforeRetry();
        } catch {
          /* best effort: the retry itself decides */
        }
      }
      await sleep(delayMs);
    }
  }
}
