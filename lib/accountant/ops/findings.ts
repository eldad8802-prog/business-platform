/**
 * The accountant package's operational findings — pure. What is wrong right now, from facts the monitor read.
 *
 * TWO KINDS OF RULE
 *   OPENING  when a fault becomes a finding (thresholds, windows: "failing for 3 h", "accepted 24–72 h ago").
 *   KEEPING  an alert that is already OPEN stays a finding until its fault is actually gone — never because it is
 *            old, because the month rolled over, or because a window passed (owner decision, 2026-10-28). An alert
 *            closes only on a real recovery, or on a documented act of the owner where the fault itself can never
 *            "recover" (a spam complaint: the owner sent the month again, or changed the accountant's address — both
 *            in the trail). A fault that cannot be checked right now (its switch is off) stays open QUIETLY: no
 *            reminders, never resolved, shown as such in the console.
 *
 * PLATFORM (from the run log, lib/accountant/ops/runs.ts)
 *   SWEEP_MISSED        the sweep is switched on but no run started for SWEEP_MISSED_AFTER_MS (two hourly runs
 *                       in a row did not happen — one late run heals itself and is not worth a message).
 *   SWEEP_FAILED        the latest run failed (a business errored, or the run crashed), or it started and never
 *                       finished (killed at the function limit).
 *   MONITOR_INCOMPLETE  this monitor run could not evaluate every business (an error, or its time budget).
 *   MONITOR_CRON_MISSED the monitor's Vercel Cron schedule has not run for SWEEP_MISSED_AFTER_MS (seen by a run the
 *                       GitHub watchdog made): one of the two monitoring channels is down.
 *   WATCHDOG_MISSED     the GitHub watchdog has not run for WATCHDOG_MISSED_AFTER_MS (seen by a Vercel Cron run):
 *                       the independent channel is down (GitHub disables idle schedules, Actions outages).
 *
 * PER BUSINESS (from the business's own rows, read under its RLS)
 *   PACKAGE_NOT_PREPARED  the closed month has no prepared package by the 2nd of the month, 06:00 Israel time.
 *   PREPARATION_FAILED    a month has been failing to prepare for PREPARATION_FAILED_AFTER_MS — measured from the
 *                         FIRST failed build of the current streak (every hourly retry re-evaluates the month).
 *   PREPARATION_STUCK     a package build has been BUILDING for PREPARATION_STUCK_AFTER_MS.
 *   RETRY_OVERDUE         an approved send whose next attempt is RETRY_OVERDUE_AFTER_MS late.
 *   SEND_STUCK            a send that stayed SENDING SEND_STUCK_AFTER_MS past its lease.
 *   SEND_UNCERTAIN        the provider never answered the month's latest send (it may have arrived).
 *   DELIVERY_FAILED       the month's latest send failed (the provider refused it, or every retry did).
 *   DELIVERY_BOUNCED      the month's latest send bounced.
 *   DELIVERY_COMPLAINED   the recipient marked a send as spam (opened once per send; no reminders).
 *   WEBHOOK_SILENT        the webhook is configured, but a send accepted 24–72 h ago has had no delivery event.
 *
 * Nothing here reads or returns an address, a link, a token, a name or a document: subjects are a month key or a
 * delivery id, details are counts, hours and short codes — what the alert tables' CHECKs allow.
 */

import { periodRange, type PeriodKey } from "../period";
import { isUncertainOutcome, type DeliveryStatus } from "../workflow-status";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";
export type FindingDetail = Record<string, number | boolean | string>;
/** `quiet`: kept open although it cannot be checked now — never reminded (not stored; detail.unchecked says so). */
export type Finding = { code: FindingCode; subjectKey: string; severity: Severity; detail: FindingDetail; quiet?: boolean };
export type OpenAlert = { code: string; subjectKey: string; detail: Record<string, unknown> };

export const H = 60 * 60 * 1000;
export const SWEEP_MISSED_AFTER_MS = 2 * H + 15 * 60 * 1000;
export const SWEEP_RUN_STALE_MS = 10 * 60 * 1000;
/** GitHub's hourly schedule fires irregularly (gaps of several hours are normal); past this it is down. */
export const WATCHDOG_MISSED_AFTER_MS = 12 * H;
export const PREPARE_DEADLINE_AFTER_MONTH_MS = 30 * H; // the 2nd, 06:00 Israel time
export const PREPARATION_FAILED_AFTER_MS = 3 * H;
export const PREPARATION_STUCK_AFTER_MS = 1 * H;
export const RETRY_OVERDUE_AFTER_MS = 2 * H;
export const SEND_STUCK_AFTER_MS = 30 * 60 * 1000;
/** A complaint OPENS an alert only while it is this recent (an old one seen for the first time is history). */
export const COMPLAINT_WINDOW_MS = 7 * 24 * H;
export const WEBHOOK_SILENT_AFTER_MS = 24 * H;
export const WEBHOOK_SILENT_WINDOW_MS = 72 * H;
/** Deliveries older than this OPEN nothing; a delivery an open alert names is always read, whatever its age. */
export const DELIVERY_LOOKBACK_MS = 30 * 24 * H;

export const FINDING_SPECS = {
  SWEEP_MISSED: { severity: "CRITICAL", remind: true, titleHe: "הסריקה החודשית לא רצה כבר יותר משעתיים" },
  SWEEP_FAILED: { severity: "CRITICAL", remind: true, titleHe: "הריצה האחרונה של הסריקה נכשלה או לא הסתיימה" },
  MONITOR_INCOMPLETE: { severity: "HIGH", remind: true, titleHe: "הניטור לא הצליח לבדוק את כל העסקים" },
  MONITOR_CRON_MISSED: { severity: "HIGH", remind: true, titleHe: "תזמון הניטור ב־Vercel לא רץ — הניטור פועל רק דרך GitHub" },
  WATCHDOG_MISSED: { severity: "HIGH", remind: true, titleHe: "בודק הניטור העצמאי ב־GitHub לא רץ — הניטור פועל רק דרך Vercel" },
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
export const PLATFORM_CODES: readonly FindingCode[] = ["SWEEP_MISSED", "SWEEP_FAILED", "MONITOR_INCOMPLETE", "MONITOR_CRON_MISSED", "WATCHDOG_MISSED"];
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
const keyOf = (f: { code: string; subjectKey: string }) => `${f.code}|${f.subjectKey}`;

/** The stored detail of an open alert, reduced to what a detail may hold. */
function storedDetail(d: Record<string, unknown>): FindingDetail {
  const out: FindingDetail = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[k] = v;
  return out;
}

/** Keeps an open alert as a finding: still faulty (`quiet` false) or not checkable now (`quiet` true, no reminders). */
function keep(a: OpenAlert, quiet: boolean): Finding | null {
  if (!isFindingCode(a.code)) return null;
  const detail = storedDetail(a.detail);
  if (quiet) detail.unchecked = true;
  else delete detail.unchecked;
  return { ...finding(a.code, a.subjectKey, detail), quiet };
}

// ── Platform ────────────────────────────────────────────────────────────────────────────────────

export type RunFact = { kind: "SWEEP" | "MONITOR"; startedAt: Date; finishedAt: Date | null; outcome: "RUNNING" | "OK" | "FAILED" };

export type PlatformFacts = {
  now: Date;
  sweepEnabled: boolean;
  /** The newest sweep runs, newest first (a handful is enough). */
  sweepRuns: RunFact[];
  /** When the monitor first ran (its oldest run), so a fresh deployment is not "missing" a sweep it never had. */
  firstMonitorRunAt: Date | null;
  /** The newest monitor run from each channel (this run included). */
  lastMonitorRunBySource?: { VERCEL_CRON: Date | null; GITHUB_ACTIONS: Date | null };
  /** This monitor run: businesses it could not evaluate (errors) and whether its time budget ran out. */
  businessesFailed: number;
  budgetExhausted: boolean;
  /** Platform alerts open before this run. */
  openAlerts?: OpenAlert[];
};

export function platformFindings(f: PlatformFacts): Finding[] {
  const out: Finding[] = [];
  const t = f.now.getTime();
  const watchedFor = f.firstMonitorRunAt ? t - f.firstMonitorRunAt.getTime() : 0;
  if (f.sweepEnabled) {
    const latest = f.sweepRuns[0] ?? null;
    const since = latest ? t - latest.startedAt.getTime() : null;
    if (latest ? since! >= SWEEP_MISSED_AFTER_MS : watchedFor >= SWEEP_MISSED_AFTER_MS) {
      out.push(finding("SWEEP_MISSED", "-", latest ? { hours: hoursSince(latest.startedAt, f.now) } : { neverRecorded: true }));
    }
    if (latest) {
      const neverFinished = latest.outcome === "RUNNING" && since! >= SWEEP_RUN_STALE_MS;
      if (latest.outcome === "FAILED" || neverFinished) {
        let failedInARow = 0;
        for (const r of f.sweepRuns) {
          const bad = r.outcome === "FAILED" || (r.outcome === "RUNNING" && t - r.startedAt.getTime() >= SWEEP_RUN_STALE_MS);
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
  // Each monitoring channel watches the other. Only once the monitor has been running long enough to know.
  const last = f.lastMonitorRunBySource;
  if (last) {
    const cron = last.VERCEL_CRON ? t - last.VERCEL_CRON.getTime() : watchedFor;
    if (cron >= SWEEP_MISSED_AFTER_MS && watchedFor >= SWEEP_MISSED_AFTER_MS) {
      out.push(finding("MONITOR_CRON_MISSED", "-", last.VERCEL_CRON ? { hours: hoursSince(last.VERCEL_CRON, f.now) } : { neverRecorded: true }));
    }
    const gh = last.GITHUB_ACTIONS ? t - last.GITHUB_ACTIONS.getTime() : watchedFor;
    if (gh >= WATCHDOG_MISSED_AFTER_MS && watchedFor >= WATCHDOG_MISSED_AFTER_MS) {
      out.push(finding("WATCHDOG_MISSED", "-", last.GITHUB_ACTIONS ? { hours: hoursSince(last.GITHUB_ACTIONS, f.now) } : { neverRecorded: true }));
    }
  }
  // Keeping: with the sweep switched off its alerts cannot be checked — they stay open, quietly.
  const have = new Set(out.map(keyOf));
  for (const a of f.openAlerts ?? []) {
    if (have.has(keyOf(a))) continue;
    if (!f.sweepEnabled && (a.code === "SWEEP_MISSED" || a.code === "SWEEP_FAILED")) {
      const k = keep(a, true);
      if (k) out.push(k);
    }
  }
  return out;
}

// ── Per business ────────────────────────────────────────────────────────────────────────────────

/** `failingSince`: the first failed build of the current failing streak (null when the month is not failing). */
export type PeriodFact = { id: number; periodKey: PeriodKey; status: string; evaluatedAt: Date | null; failingSince?: Date | null };
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
export type ComplaintFact = { deliveryId: number; occurredAt: Date };

export type BusinessFacts = {
  now: Date;
  sweepEnabled: boolean;
  webhookConfigured: boolean;
  /** The most recently closed month. */
  latestKey: PeriodKey;
  /** Every period the facts below refer to, the latest one, and every month an open alert names. */
  periods: PeriodFact[];
  buildingPackages: BuildingPackageFact[];
  /** Deliveries in flight, every delivery of the lookback window, and every delivery an open alert names. */
  deliveries: DeliveryFact[];
  /** Spam complaints: recent ones, and those of deliveries an alert already named. */
  complaints: ComplaintFact[];
  /** Deliveries that ever had a complaint alert (open or resolved): a complaint opens ONE alert, once. */
  complaintAlerted?: number[];
  /** The owner last set or changed the accountant's address (trail: RECIPIENT_SET / RECIPIENT_CHANGED). */
  recipientChangedAt?: Date | null;
  /** This business's alerts open before this run. */
  openAlerts?: OpenAlert[];
};

export function businessFindings(f: BusinessFacts): Finding[] {
  const out: Finding[] = [];
  const t = f.now.getTime();
  const byId = new Map(f.periods.map((p) => [p.id, p]));
  const byKey = new Map(f.periods.map((p) => [p.periodKey, p]));
  const pKey = (periodId: number) => byId.get(periodId)?.periodKey ?? null;
  const prepared = (p: PeriodFact | undefined) => !!p && p.status !== "PREPARING" && p.evaluatedAt !== null;

  if (f.sweepEnabled) {
    const deadline = periodRange(f.latestKey).toExclusive.getTime() + PREPARE_DEADLINE_AFTER_MONTH_MS;
    const latest = byKey.get(f.latestKey);
    if (t >= deadline && !prepared(latest)) {
      out.push(finding("PACKAGE_NOT_PREPARED", `p:${f.latestKey}`, { periodRow: latest !== undefined }));
    }
  }
  for (const p of f.periods) {
    const since = p.failingSince ?? null;
    if (p.status === "PREPARATION_FAILED" && since && t - since.getTime() >= PREPARATION_FAILED_AFTER_MS) {
      out.push(finding("PREPARATION_FAILED", `p:${p.periodKey}`, { hours: hoursSince(since, f.now) }));
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
  const deliveryById = new Map(f.deliveries.map((d) => [d.id, d]));

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

  // A complaint is an event: it opens ONE alert per send, and only while recent. It can never "recover" by itself;
  // it is handled by a documented act of the owner (see complaintHandled), never by time.
  const alerted = new Set(f.complaintAlerted ?? []);
  const openComplaints = new Set((f.openAlerts ?? []).filter((a) => a.code === "DELIVERY_COMPLAINED").map((a) => a.subjectKey));
  const complaintAt = new Map<number, Date>();
  for (const c of f.complaints) {
    const cur = complaintAt.get(c.deliveryId);
    if (!cur || c.occurredAt < cur) complaintAt.set(c.deliveryId, c.occurredAt);
  }
  const complaintHandled = (deliveryId: number) => {
    const d = deliveryById.get(deliveryId);
    const at = complaintAt.get(deliveryId);
    const resent = !!d && [...latestOfPeriod.values()].some((x) => x.periodId === d.periodId && x.id > d.id);
    const addressChanged = !!at && !!f.recipientChangedAt && f.recipientChangedAt.getTime() > at.getTime();
    return resent || addressChanged;
  };
  for (const [id, at] of complaintAt) {
    if (alerted.has(id) || openComplaints.has(`d:${id}`)) continue;
    if (t - at.getTime() < COMPLAINT_WINDOW_MS && !complaintHandled(id)) out.push(finding("DELIVERY_COMPLAINED", `d:${id}`));
  }

  // Keeping: every alert open before this run stays open until its fault is actually gone.
  const have = new Set(out.map(keyOf));
  for (const a of f.openAlerts ?? []) {
    if (have.has(keyOf(a))) continue;
    const id = a.subjectKey.startsWith("d:") ? Number(a.subjectKey.slice(2)) : null;
    const month = a.subjectKey.startsWith("p:") ? (a.subjectKey.slice(2) as PeriodKey) : null;
    const d = id !== null ? deliveryById.get(id) : undefined;
    let kept: Finding | null = null;
    switch (a.code) {
      case "PACKAGE_NOT_PREPARED": // the month rolled over, or the sweep is off: still not prepared → still a fault
        if (month && !prepared(byKey.get(month))) kept = keep(a, !f.sweepEnabled);
        break;
      case "PREPARATION_FAILED":
        if (month && byKey.get(month)?.status === "PREPARATION_FAILED") kept = keep(a, false);
        break;
      case "WEBHOOK_SILENT": // past the 72 h window, still no event; with the webhook off it cannot be checked
        if (d && d.status === "ACCEPTED") kept = keep(a, !f.webhookConfigured);
        break;
      case "DELIVERY_COMPLAINED":
        if (id !== null && !complaintHandled(id)) kept = keep(a, false);
        break;
      default:
        // Retry / stuck / uncertain / failed / bounced / stuck build are evaluated from rows that are always read
        // (in-flight sends, building packages, and every delivery or month an open alert names): absent = recovered.
        // A delivery that no longer exists at all cannot be checked — kept quietly rather than called fixed.
        if (id !== null && !d) kept = keep(a, true);
        break;
    }
    if (kept) out.push(kept);
  }
  return out;
}

/** Subjects an open alert names: the deliveries and months the monitor must read whatever their age. */
export function subjectsOf(alerts: { subjectKey: string }[]): { deliveryIds: number[]; periodKeys: PeriodKey[] } {
  const deliveryIds: number[] = [];
  const periodKeys: PeriodKey[] = [];
  for (const a of alerts) {
    if (/^d:\d{1,10}$/.test(a.subjectKey)) deliveryIds.push(Number(a.subjectKey.slice(2)));
    else if (/^p:\d{4}-\d{2}$/.test(a.subjectKey)) periodKeys.push(a.subjectKey.slice(2) as PeriodKey);
  }
  return { deliveryIds: [...new Set(deliveryIds)], periodKeys: [...new Set(periodKeys)] };
}

/** The subject a person reads: "חודש 2026-09", "שליחה #12". */
export function subjectLabelHe(subjectKey: string): string {
  if (subjectKey.startsWith("p:")) return `חודש ${subjectKey.slice(2)}`;
  if (subjectKey.startsWith("d:")) return `שליחה #${subjectKey.slice(2)}`;
  return "";
}
