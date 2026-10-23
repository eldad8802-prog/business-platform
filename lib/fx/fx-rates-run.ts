/**
 * One Bank of Israel fetch run: both series (USD/ILS, EUR/ILS) for the last 10 days (Asia/Jerusalem), parsed
 * fail-closed, appended through the writer. A pair whose fetch or parse fails writes NOTHING (the other pair
 * is unaffected) and makes the run unhealthy; the next run back-fills the window.
 *
 * Not scheduled anywhere: the only caller is app/api/cron/fx-rates/route.ts, which itself refuses unless
 * FX_RATES_FETCH_ENABLED === "true" (docs/i18n-multicurrency/FX-ACTIVATION-RUNBOOK.md).
 */
import { fetchBoiSeries, type BoiFetchFailure } from "./boi-client";
import { addCivilDays, BOI_BASES, boiSeriesCode, civilDateIn, parseBoiCsv, type BoiBase, type BoiObservation, type BoiRejection } from "./boi-parser";
import { fxRateWriterConfig, writeBoiRates, type FxRateEvent, type PairWrite } from "./fx-rate-writer";

export const FETCH_WINDOW_DAYS = 10;

export type PairSummary = {
  readonly pair: `${BoiBase}/ILS`;
  readonly series: string;
  readonly fetched: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly unverified: number;
  readonly revised: number;
  readonly rejected: number;
  readonly error: BoiFetchFailure | "PARSE_REJECTED" | null;
  readonly httpStatus?: number;
  /** Up to 5 parser reasons (no payload beyond the offending field values). */
  readonly rejections?: readonly BoiRejection[];
};

export type FxRunSummary =
  | {
      readonly ok: boolean;
      readonly window: { readonly start: string; readonly end: string };
      readonly fetchedAt: string;
      readonly pairs: readonly PairSummary[];
      readonly events: readonly FxRateEvent[];
    }
  | { readonly ok: false; readonly error: "WRITER_NOT_CONFIGURED" | "WRITER_SHARES_ANOTHER_CONNECTION" };

export type FxRunOptions = {
  readonly now?: Date;
  /** CI lab only (loopback); the route never passes it. */
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (level: "warn" | "error", tag: string, data: Record<string, unknown>) => void;
};

const defaultLog: NonNullable<FxRunOptions["log"]> = (level, tag, data) => {
  if (level === "error") console.error(`[fx-rates] ${tag}`, data);
  else console.warn(`[fx-rates] ${tag}`, data);
};

export async function runFxRateFetch(opts: FxRunOptions = {}): Promise<FxRunSummary> {
  const log = opts.log ?? defaultLog;
  const config = fxRateWriterConfig(opts.env ?? process.env);
  if (!config.ok) {
    const error = config.reason === "NOT_CONFIGURED" ? "WRITER_NOT_CONFIGURED" : "WRITER_SHARES_ANOTHER_CONNECTION";
    log("error", "refused", { error });
    return { ok: false, error };
  }
  const now = opts.now ?? new Date();
  const today = civilDateIn(now, "Asia/Jerusalem");
  const start = addCivilDays(today, -(FETCH_WINDOW_DAYS - 1));

  const fetched = await Promise.all(
    BOI_BASES.map(async (base) => ({ base, res: await fetchBoiSeries(base, start, today, { origin: opts.origin, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }) }))
  );

  const writes: PairWrite[] = [];
  const failed = new Map<BoiBase, PairSummary>();
  const parsedCount = new Map<BoiBase, number>();
  for (const { base, res } of fetched) {
    const series = boiSeriesCode(base);
    const pair = `${base}/ILS` as const;
    if (!res.ok) {
      log("error", "fetch_failed", { pair, failure: res.failure, status: res.status ?? null });
      failed.set(base, { pair, series, fetched: 0, inserted: 0, skipped: 0, unverified: 0, revised: 0, rejected: 0, error: res.failure, ...(res.status !== undefined ? { httpStatus: res.status } : {}) });
      continue;
    }
    const parsed = parseBoiCsv(res.text, { base, today, startPeriod: start, endPeriod: today });
    if (!parsed.ok) {
      log("error", "parse_rejected", { pair, rejections: parsed.rejections.length, first: parsed.rejections[0]?.reason ?? null });
      failed.set(base, { pair, series, fetched: 0, inserted: 0, skipped: 0, unverified: 0, revised: 0, rejected: parsed.rejections.length, error: "PARSE_REJECTED", rejections: parsed.rejections.slice(0, 5) });
      continue;
    }
    parsedCount.set(base, parsed.observations.length);
    writes.push({ base, observations: parsed.observations as BoiObservation[], sourceRef: `${series} ${res.url}` });
  }

  const written = writes.length > 0 ? await writeBoiRates(writes, now) : { ok: true as const, fetchedAt: now.toISOString(), pairs: [] };
  if (!written.ok) {
    log("error", "refused", { error: written.reason });
    return { ok: false, error: "WRITER_NOT_CONFIGURED" };
  }
  const events = written.pairs.flatMap((p) => p.events);
  for (const e of events) log(e.event === "FX_RATE_REVISED" ? "warn" : "error", "alert", { ...e });

  const pairs: PairSummary[] = BOI_BASES.map((base) => {
    const f = failed.get(base);
    if (f) return f;
    const w = written.pairs.find((p) => p.base === base)!;
    return { pair: `${base}/ILS`, series: boiSeriesCode(base), fetched: parsedCount.get(base) ?? 0, inserted: w.inserted, skipped: w.skipped, unverified: w.unverified, revised: w.revised, rejected: 0, error: null };
  });
  return { ok: failed.size === 0, window: { start, end: today }, fetchedAt: written.fetchedAt, pairs, events };
}
