/**
 * The accountant package's operational findings — pure. What is wrong right now, from facts the monitor read.
 *
 * PLATFORM (from the run log, lib/accountant/ops/runs.ts)
 *   SWEEP_MISSED        the sweep is switched on but no run started for SWEEP_MISSED_AFTER_MS (two hourly runs
 *                       in a row did not happen — one late run heals itself and is not worth a message).
 *   SWEEP_FAILED        the latest run failed (a business errored, or the run crashed), or it started and never
 *                       finished (killed at the function limit).
 *   MONITOR_INCOMPLETE  this monitor run could not evaluate every business (an error, or its time budget).
 *
 * PER BUSINESS (from the business's own rows, read under its RLS)
 *   PACKAGE_NOT_PREPARED  the closed month has no prepared package by the 2nd of the month, 06:00 Israel time.
 *   PREPARATION_FAILED    a month stayed PREPARATION_FAILED for PREPARATION_FAILED_AFTER_MS (hourly retries failed).
 *   PREPARATION_STUCK     a package build has been BUILDING for PREPARATION_STUCK_AFTER_MS.
 *   RETRY_OVERDUE         an approved send whose next attempt is RETRY_OVERDUE_AFTER_MS late.
 *   SEND_STUCK            a send that stayed SENDING SEND_STUCK_AFTER_MS past its lease.
 *   SEND_UNCERTAIN        the provider never answered the month's latest send (it may have arrived).
 *   DELIVERY_FAILED       the month's latest send failed (the provider refused it, or every retry did).
 *   DELIVERY_BOUNCED      the month's latest send bounced.
 *   DELIVERY_COMPLAINED   the recipient marked a send as spam within COMPLAINT_WINDOW_MS (no reminders).
 *   WEBHOOK_SILENT        the webhook is configured, but a send accepted 24–72 h ago has had no delivery event.
 *
 * Nothing here reads or returns an address, a link, a token, a name or a document: subjects are a month key or a
 * delivery id, details are counts, hours and short codes — what the alert tables' CHECKs allow.
 */

import { periodRange, type PeriodKey } from "../period";
import { isUncertainOutcome, type DeliveryStatus } from "../workflow-status";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";
export type FindingDetail = Record<string, number | boolean | string>;
export type Finding = { code: FindingCode; subjectKey: string; severity: Severity; detail: FindingDetail };

export const H = 60 * 60 * 1000;
export const SWEEP_MISSED_AFTER_MS = 2 * H + 15 * 60 * 1000;
export const SWEEP_RUN_STALE_MS = 10 * 60 * 1000;
export const PREPARE_DEADLINE_AFTER_MONTH_MS = 30 * H; // the 2nd, 06:00 Israel time
export const PREPARATION_FAILED_AFTER_MS = 3 * H;
export const PREPARATION_STUCK_AFTER_MS = 1 * H;
export const RETRY_OVERDUE_AFTER_MS = 2 * H;
export const SEND_STUCK_AFTER_MS = 30 * 60 * 1000;
export const COMPLAINT_WINDOW_MS = 7 * 24 * H;
export const WEBHOOK_SILENT_AFTER_MS = 24 * H;
export const WEBHOOK_SILENT_WINDOW_MS = 72 * H;
/** Deliveries older than this are history, not operations. */
export const DELIVERY_LOOKBACK_MS = 30 * 24 * H;

export const FINDING_SPECS = {
  SWEEP_MISSED: { severity: "CRITICAL", remind: true, titleHe: "הסריקה החודשית לא רצה כבר יותר משעתיים" },
  SWEEP_FAILED: { severity: "CRITICAL", remind: true, titleHe: "הריצה האחרונה של הסריקה נכשלה או לא הסתיימה" },
  MONITOR_INCOMPLETE: { severity: "HIGH", remind: true, titleHe: "הניטור לא הצליח לבדוק את כל העסקים" },
  PACKAGE_NOT_PREPARED: { severity: "CRITICAL", remind: true, titleHe: "החבילה של החודש שנסגר לא הוכנה בזמן" },
  PREPARATION_FAILED: { severity: "HIGH", remind: true, titleHe: "הכנת החבילה נכשלת שוב ושוב" },
  PREPARATION_STUCK: { severity: "HIGH", remind: true, titleHe: "הכנת החבילה תקועה" },
  RETRY_OVERDUE: { severity: "HIGH", remind: true, titleHe: "ניסיון שליחה חוזר מתעכב" },
  SEND_STUCK: { severity: "CRITICAL", remind: true, titleHe: "שליחה תקועה במצב \"בשליחה\"" },
  SEND_UNCERTAIN: { severity: "CRITICAL", remind: true, titleHe: "לא ודאי אם המייל נשלח — ספק המייל לא ענה" },
  DELIVERY_FAILED: { severity: "HIGH", remind: true, titleHe: "השליחה לרואה החשבון נכשלה" },
  DELIVERY_BOUNCED: { severity: "HIGH", remind: true, titleHe: "המייל לרואה החשבון חזר (bounce)" },
  DELIVERY_COMPLAINED: { severity: "MEDIUM", remind: false, titleHe: "הנמען סימן את המייל כספאם" },
  WEBHOOK_SILENT: { severity: "MEDIUM", remind: true, titleHe: "לא התקבל אירוע מסירה מספק המייל" },
} as const satisfies Record<string, { severity: Severity; remind: boolean; titleHe: string }>;

export type FindingCode = keyof typeof FINDING_SPECS;
export const PLATFORM_CODES: readonly FindingCode[] = ["SWEEP_MISSED", "SWEEP_FAILED", "MONITOR_INCOMPLETE"];
export const REMINDABLE_CODES: readonly FindingCode[] = (Object.keys(FINDING_SPECS) as FindingCode[]).filter(
  (c) => FINDING_SPECS[c].remind
);

export function isFindingCode(value: string): value is FindingCode {
  return Object.prototype.hasOwnProperty.call(FINDING_SPECS, value);
}

function finding(code: FindingCode, subjectKey: string, detail: FindingDetail = {}): Finding {
  return { code, subjectKey, severity: FINDING_SPECS[code].severity, detail };
}

const hoursSince = (at: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / H));

// ── Platform ────────────────────────────────────────────────────────────────────────────────────

export type RunFact = { kind: "SWEEP" | "MONITOR"; startedAt: Date; finishedAt: Date | null; outcome: "RUNNING" | "OK" | "FAILED" };

export type PlatformFacts = {
  now: Date;
  sweepEnabled: boolean;
  /** The newest sweep runs, newest first (a handful is enough). */
  sweepRuns: RunFact[];
  /** When the monitor first ran (its oldest run), so a fresh deployment is not "missing" a sweep it never had. */
  firstMonitorRunAt: Date | null;
  /** This monitor run: businesses it could not evaluate (errors) and whether its time budget ran out. */
  businessesFailed: number;
  budgetExhausted: boolean;
};

export function platformFindings(f: PlatformFacts): Finding[] {
  const out: Finding[] = [];
  if (f.sweepEnabled) {
    const latest = f.sweepRuns[0] ?? null;
    const since = latest ? f.now.getTime() - latest.startedAt.getTime() : null;
    const watchedLongEnough = f.firstMonitorRunAt !== null && f.now.getTime() - f.firstMonitorRunAt.getTime() >= SWEEP_MISSED_AFTER_MS;
    if (latest ? since! >= SWEEP_MISSED_AFTER_MS : watchedLongEnough) {
      out.push(finding("SWEEP_MISSED", "-", latest ? { hours: hoursSince(latest.startedAt, f.now) } : { neverRecorded: true }));
    }
    if (latest) {
      const neverFinished = latest.outcome === "RUNNING" && since! >= SWEEP_RUN_STALE_MS;
      if (latest.outcome === "FAILED" || neverFinished) {
        let failedInARow = 0;
        for (const r of f.sweepRuns) {
          const bad = r.outcome === "FAILED" || (r.outcome === "RUNNING" && f.now.getTime() - r.startedAt.getTime() >= SWEEP_RUN_STALE_MS);
          if (!bad) break;
          failedInARow += 1;
        }
        out.push(finding("SWEEP_FAILED", "-", { neverFinished, failedInARow }));
      }
    }
  }
  if (f.businessesFailed > 0 || f.budgetExhausted) {
    out.push(finding("MONITOR_INCOMPLETE", "-", { businessesFailed: f.businessesFailed, budgetExhausted: f.budgetExhausted }));
  }
  return out;
}

// ── Per business ────────────────────────────────────────────────────────────────────────────────

export type PeriodFact = { id: number; periodKey: PeriodKey; status: string; evaluatedAt: Date | null };
export type BuildingPackageFact = { periodId: number; createdAt: Date };
export type DeliveryFact = {
  id: number;
  periodId: number;
  status: DeliveryStatus;
  failureCode: string | null;
  approvedAt: Date;
  nextAttemptAt: Date | null;
  leaseUntil: Date | null;
  acceptedAt: Date | null;
  updatedAt: Date;
};

export type BusinessFacts = {
  now: Date;
  sweepEnabled: boolean;
  webhookConfigured: boolean;
  /** The most recently closed month. */
  latestKey: PeriodKey;
  /** Every period the facts below refer to, plus the latest one if it exists. */
  periods: PeriodFact[];
  buildingPackages: BuildingPackageFact[];
  /** Deliveries in flight, and every delivery of the lookback window. */
  deliveries: DeliveryFact[];
  /** Spam complaints recorded within the complaint window: delivery ids. */
  complainedDeliveryIds: number[];
};

export function businessFindings(f: BusinessFacts): Finding[] {
  const out: Finding[] = [];
  const t = f.now.getTime();
  const byId = new Map(f.periods.map((p) => [p.id, p]));
  const pKey = (periodId: number) => byId.get(periodId)?.periodKey ?? null;

  if (f.sweepEnabled) {
    const deadline = periodRange(f.latestKey).toExclusive.getTime() + PREPARE_DEADLINE_AFTER_MONTH_MS;
    const latest = f.periods.find((p) => p.periodKey === f.latestKey) ?? null;
    if (t >= deadline && (!latest || latest.status === "PREPARING" || latest.evaluatedAt === null)) {
      out.push(finding("PACKAGE_NOT_PREPARED", `p:${f.latestKey}`, { periodRow: latest !== null }));
    }
  }
  for (const p of f.periods) {
    if (p.status === "PREPARATION_FAILED" && p.evaluatedAt && t - p.evaluatedAt.getTime() >= PREPARATION_FAILED_AFTER_MS) {
      out.push(finding("PREPARATION_FAILED", `p:${p.periodKey}`, { hours: hoursSince(p.evaluatedAt, f.now) }));
    }
  }
  const stuckPeriods = new Set<number>();
  for (const b of f.buildingPackages) {
    if (t - b.createdAt.getTime() < PREPARATION_STUCK_AFTER_MS || stuckPeriods.has(b.periodId)) continue;
    const key = pKey(b.periodId);
    if (!key) continue;
    stuckPeriods.add(b.periodId);
    out.push(finding("PREPARATION_STUCK", `p:${key}`, { hours: hoursSince(b.createdAt, f.now) }));
  }

  // The latest send of each month that was not withdrawn: the one the owner's screen and status describe.
  const latestOfPeriod = new Map<number, DeliveryFact>();
  for (const d of f.deliveries) {
    if (d.status === "CANCELED") continue;
    const cur = latestOfPeriod.get(d.periodId);
    if (!cur || d.id > cur.id) latestOfPeriod.set(d.periodId, d);
  }

  for (const d of f.deliveries) {
    const subject = `d:${d.id}`;
    if (d.status === "APPROVED") {
      const due = (d.nextAttemptAt ?? d.approvedAt).getTime();
      if (t - due >= RETRY_OVERDUE_AFTER_MS) out.push(finding("RETRY_OVERDUE", subject, { hours: hoursSince(new Date(due), f.now) }));
    }
    if (d.status === "SENDING") {
      const since = (d.leaseUntil ?? d.updatedAt).getTime();
      if (t - since >= SEND_STUCK_AFTER_MS) out.push(finding("SEND_STUCK", subject, { hours: hoursSince(new Date(since), f.now) }));
    }
    if (d.status === "ACCEPTED" && f.webhookConfigured && d.acceptedAt) {
      const age = t - d.acceptedAt.getTime();
      if (age >= WEBHOOK_SILENT_AFTER_MS && age < WEBHOOK_SILENT_WINDOW_MS) {
        out.push(finding("WEBHOOK_SILENT", subject, { hours: hoursSince(d.acceptedAt, f.now) }));
      }
    }
    const period = byId.get(d.periodId);
    if (latestOfPeriod.get(d.periodId)?.id === d.id && period?.status === "SEND_FAILED") {
      if (isUncertainOutcome(d.status, d.failureCode)) out.push(finding("SEND_UNCERTAIN", subject, { code: d.failureCode ?? "" }));
      else if (d.status === "FAILED") out.push(finding("DELIVERY_FAILED", subject, { code: d.failureCode ?? "" }));
      else if (d.status === "BOUNCED") out.push(finding("DELIVERY_BOUNCED", subject));
    }
  }
  for (const id of new Set(f.complainedDeliveryIds)) out.push(finding("DELIVERY_COMPLAINED", `d:${id}`));
  return out;
}

/** The subject a person reads: "חודש 2026-09", "שליחה #12". */
export function subjectLabelHe(subjectKey: string): string {
  if (subjectKey.startsWith("p:")) return `חודש ${subjectKey.slice(2)}`;
  if (subjectKey.startsWith("d:")) return `שליחה #${subjectKey.slice(2)}`;
  return "";
}
