/**
 * Appends Bank of Israel representative rates to "FxRate" — and only that.
 *
 * Two connections, two roles, on purpose:
 *   - READ  through the runtime client (lib/prisma.ts → app_runtime: SELECT only on "FxRate"), to decide what
 *           is new. "FxRate" is read-open reference data (policy fx_rate_read USING (true)), not tenant data.
 *   - WRITE through lib/prisma-fx-writer.ts (a LOGIN member of fx_rate_writer: INSERT only, no SELECT), as a
 *           plain INSERT without RETURNING. No writer URL → "not configured", nothing written; never the
 *           runtime's connection.
 *
 * Rules (FX-SOURCE-RECOMMENDATION.md §3–§5):
 *   - idempotent: a date whose NEWEST stored value (latest fetchedAt) equals the published one is skipped;
 *   - a changed value for a stored date is a NEW row with this run's (later) fetchedAt — never an update
 *     (the table refuses updates for every role); an FX_RATE_REVISED event is logged;
 *   - a move of more than 5% against the previous business day's rate is stored UNVERIFIED and logged as an
 *     FX_RATE_JUMP alert; a rate with no earlier rate within 10 days to compare against is stored UNVERIFIED
 *     (FX_RATE_NO_BASELINE) — the accounting policy refuses UNVERIFIED rates until an admin verifies;
 *   - one run = one writer transaction holding a transaction-level advisory lock, so two overlapping runs
 *     serialise and the second sees the first's rows (and skips them).
 *
 * Nothing here converts money: storage, validation and status only.
 */
import { prisma } from "@/lib/prisma";
import { fxWriterConfig, getPrismaFxWriter, type FxWriterConfig } from "@/lib/prisma-fx-writer";
import { parseScaled } from "@/lib/money/decimal";
import { RATE_SCALE, canonicalRateString } from "@/lib/money/fx";

import { addCivilDays, type BoiBase, type BoiObservation } from "./boi-parser";

/** More than this many basis points against the previous business day ⇒ UNVERIFIED (5%). */
export const JUMP_THRESHOLD_BP = 500;
/** How far back a "previous business day" rate may be looked for (weekends + the longest holiday run). */
export const BASELINE_LOOKBACK_DAYS = 10;

export type StoredRate = {
  readonly rateDate: string;
  /** Canonical RATE_SCALE decimal string. */
  readonly rate: string;
  /** ISO instant. */
  readonly fetchedAt: string;
  readonly verification: "VERIFIED" | "UNVERIFIED";
};

export type FxRateEvent =
  | { readonly event: "FX_RATE_JUMP"; readonly base: BoiBase; readonly rateDate: string; readonly rate: string; readonly previousDate: string; readonly previousRate: string; readonly changeBp: number }
  | { readonly event: "FX_RATE_NO_BASELINE"; readonly base: BoiBase; readonly rateDate: string; readonly rate: string }
  | { readonly event: "FX_RATE_REVISED"; readonly base: BoiBase; readonly rateDate: string; readonly rate: string; readonly storedRate: string };

export type PlannedInsert = {
  readonly base: BoiBase;
  readonly rateDate: string;
  readonly rate: string;
  readonly verification: "VERIFIED" | "UNVERIFIED";
};

export type PairPlan = {
  readonly inserts: readonly PlannedInsert[];
  readonly skipped: number;
  readonly events: readonly FxRateEvent[];
};

/** |a − b| / b in basis points, rounded down (exact bigint arithmetic). */
export function changeBasisPoints(rate: string, previous: string): number {
  const a = parseScaled(rate, RATE_SCALE);
  const b = parseScaled(previous, RATE_SCALE);
  if (b <= BigInt(0)) throw new RangeError("previous rate must be positive");
  const diff = a > b ? a - b : b - a;
  return Number((diff * BigInt(10_000)) / b);
}

/** True when the move exceeds the threshold — exact: |a − b| × 10 000 > threshold × b. */
export function isJump(rate: string, previous: string, thresholdBp = JUMP_THRESHOLD_BP): boolean {
  const a = parseScaled(rate, RATE_SCALE);
  const b = parseScaled(previous, RATE_SCALE);
  const diff = a > b ? a - b : b - a;
  return diff * BigInt(10_000) > BigInt(thresholdBp) * b;
}

/**
 * Pure: what to append for one pair, given the published observations and what is stored for that pair
 * (the window plus BASELINE_LOOKBACK_DAYS before it).
 */
export function planPair(base: BoiBase, observations: readonly BoiObservation[], stored: readonly StoredRate[]): PairPlan {
  // The value a date currently has = its newest row.
  const current = new Map<string, StoredRate>();
  for (const s of stored) {
    const rate = canonicalRateString(s.rate);
    const prev = current.get(s.rateDate);
    if (!prev || s.fetchedAt > prev.fetchedAt) current.set(s.rateDate, { ...s, rate });
  }
  const known = new Map<string, string>([...current].map(([d, s]) => [d, s.rate]));
  const inserts: PlannedInsert[] = [];
  const events: FxRateEvent[] = [];
  let skipped = 0;
  const ordered = [...observations].sort((a, b) => (a.rateDate < b.rateDate ? -1 : a.rateDate > b.rateDate ? 1 : 0));
  for (const o of ordered) {
    if (o.base !== base) throw new RangeError(`observation for ${o.base} in the ${base} plan`);
    const rate = canonicalRateString(o.rate);
    const existing = current.get(o.rateDate);
    if (existing && existing.rate === rate) {
      skipped += 1;
      continue;
    }
    if (existing) events.push({ event: "FX_RATE_REVISED", base, rateDate: o.rateDate, rate, storedRate: existing.rate });

    const floor = addCivilDays(o.rateDate, -BASELINE_LOOKBACK_DAYS);
    let previousDate: string | null = null;
    for (const d of known.keys()) if (d < o.rateDate && d >= floor && (previousDate === null || d > previousDate)) previousDate = d;

    let verification: "VERIFIED" | "UNVERIFIED" = "VERIFIED";
    if (previousDate === null) {
      verification = "UNVERIFIED";
      events.push({ event: "FX_RATE_NO_BASELINE", base, rateDate: o.rateDate, rate });
    } else {
      const previousRate = known.get(previousDate)!;
      if (isJump(rate, previousRate)) {
        verification = "UNVERIFIED";
        events.push({ event: "FX_RATE_JUMP", base, rateDate: o.rateDate, rate, previousDate, previousRate, changeBp: changeBasisPoints(rate, previousRate) });
      }
    }
    inserts.push({ base, rateDate: o.rateDate, rate, verification });
    known.set(o.rateDate, rate);
  }
  return { inserts, skipped, events };
}

export type PairWrite = {
  readonly base: BoiBase;
  readonly observations: readonly BoiObservation[];
  /** Series code + request URL (≤ 2048 chars), stored as sourceRef. */
  readonly sourceRef: string;
};

export type PairWriteResult = {
  readonly base: BoiBase;
  readonly inserted: number;
  readonly skipped: number;
  readonly unverified: number;
  readonly revised: number;
  readonly events: readonly FxRateEvent[];
};

export type WriteResult =
  | { readonly ok: true; readonly fetchedAt: string; readonly pairs: readonly PairWriteResult[] }
  | { readonly ok: false; readonly reason: "WRITER_NOT_CONFIGURED" };

/** Whether the writer credential is configured (and is not another connection's URL). Nothing is opened. */
export function fxRateWriterConfig(env: Readonly<Record<string, string | undefined>> = process.env): FxWriterConfig {
  return fxWriterConfig(env);
}

/** Runtime read (SELECT only) of one pair's stored BoI rates from `from` on. */
export async function readStoredBoiRates(base: BoiBase, from: string): Promise<StoredRate[]> {
  const rows = await prisma.fxRate.findMany({
    where: { base, quote: "ILS", kind: "REPRESENTATIVE", source: "BANK_OF_ISRAEL", rateDate: { gte: new Date(`${from}T00:00:00.000Z`) } },
    select: { rateDate: true, rate: true, fetchedAt: true, verification: true },
  });
  return rows.map((r) => ({
    rateDate: r.rateDate.toISOString().slice(0, 10),
    rate: canonicalRateString(r.rate.toFixed(RATE_SCALE)),
    fetchedAt: r.fetchedAt.toISOString(),
    verification: r.verification === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
  }));
}

/** fetchedAt as a timestamp(3) literal in UTC (the column has no time zone; the app stores UTC). */
function utcTimestampText(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

export async function writeBoiRates(pairs: readonly PairWrite[], fetchedAt: Date): Promise<WriteResult> {
  const writer = getPrismaFxWriter();
  if (!writer) return { ok: false, reason: "WRITER_NOT_CONFIGURED" };
  const at = utcTimestampText(fetchedAt);
  const results = await writer.$transaction(
    async (tx) => {
      // Serialise overlapping runs: the second waits here, then reads the first's committed rows.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dubiz.fx_rate_writer.boi'))`;
      const out: PairWriteResult[] = [];
      for (const p of pairs) {
        if (p.observations.length === 0) {
          out.push({ base: p.base, inserted: 0, skipped: 0, unverified: 0, revised: 0, events: [] });
          continue;
        }
        const earliest = p.observations.reduce((m, o) => (o.rateDate < m ? o.rateDate : m), p.observations[0].rateDate);
        const stored = await readStoredBoiRates(p.base, addCivilDays(earliest, -BASELINE_LOOKBACK_DAYS));
        const plan = planPair(p.base, p.observations, stored);
        const sourceRef = p.sourceRef.slice(0, 2048);
        for (const i of plan.inserts) {
          await tx.$executeRaw`INSERT INTO "FxRate" ("base", "quote", "rate", "kind", "source", "rateDate", "fetchedAt", "verification", "sourceRef")
            VALUES (${i.base}, 'ILS', ${i.rate}::numeric(20,10), 'REPRESENTATIVE', 'BANK_OF_ISRAEL', ${i.rateDate}::date, ${at}::timestamp(3), ${i.verification}, ${sourceRef})`;
        }
        out.push({
          base: p.base,
          inserted: plan.inserts.length,
          skipped: plan.skipped,
          unverified: plan.inserts.filter((i) => i.verification === "UNVERIFIED").length,
          revised: plan.events.filter((e) => e.event === "FX_RATE_REVISED").length,
          events: plan.events,
        });
      }
      return out;
    },
    { maxWait: 10_000, timeout: 30_000, isolationLevel: "ReadCommitted" }
  );
  return { ok: true, fetchedAt: fetchedAt.toISOString(), pairs: results };
}
