/**
 * The monthly accountant workflow in the owner's notification centre, /attention and Home.
 *
 * Same three layers as every other consumer: the truth is the period row, the decision is the existing
 * notification policy, the memory is the existing writer. Nothing here sends anything outside the app —
 * the documents rules grant IN_APP only.
 *
 * ONE LIVE NOTIFICATION PER PERIOD, ONE IDENTITY PER STATE
 *   Each state the owner must act on has its own entity type (`accountant_period_ready`, …, keyed on the
 *   period id). Entering a state writes that identity and resolves the others, so a period that turns
 *   from "missing items" into "ready" says so at once instead of waiting out a cooldown — and there is
 *   never more than one open notification for one month.
 *
 * REMINDERS (D1: quiet by design)
 *   Only for the most recently closed month, only while the owner still has to act, at most two: on the
 *   5th and on the 10th of the following month (before the 15th, when monthly VAT reports are due), each
 *   at least two days after the previous notice. Older open months stay visible in /attention and on the
 *   period screen without re-notifying.
 */

import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import type { BusinessStatusItemBuild } from "@/lib/business-status/types";
import { buildDedupeKey } from "@/lib/notifications/notification-policy";
import {
  persistSnapshotNotifications,
  resolveNotificationByDedupeKey,
} from "@/lib/notifications/notification-writer";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { jerusalemDayOfMonth, monthNameHe, previousPeriodKey, type PeriodKey } from "./period";
import { appendEvent, openItemsOfStored, parseStoredReadiness, type StoredReadiness } from "./store";
import { isCompleted, OWNER_ACTION_STATUSES, type PeriodStatus } from "./workflow-status";

export const ACCOUNTANT_ENTITY_TYPES = {
  READY: "accountant_period_ready",
  ATTENTION: "accountant_period_attention",
  FAILED: "accountant_period_failed",
  SEND_FAILED: "accountant_period_send_failed",
  CHANGED: "accountant_period_changed",
} as const;

export type NoticeKind = keyof typeof ACCOUNTANT_ENTITY_TYPES;

/** Jerusalem days of the following month on which a reminder may go out (at most one per entry). */
export const REMINDER_DAYS = [5, 10] as const;
export const MIN_REMINDER_GAP_MS = 72 * 60 * 60 * 1000; // = the documents rule cooldown

export type PeriodNoticeInput = {
  businessId: number;
  periodId: number;
  periodKey: PeriodKey;
  status: PeriodStatus;
  changedSinceSent: boolean;
  readiness: StoredReadiness | null;
};

/** Which notice a period deserves right now, if any. */
export function noticeKindFor(p: Pick<PeriodNoticeInput, "status" | "changedSinceSent">): NoticeKind | null {
  if (isCompleted(p.status)) return p.changedSinceSent ? "CHANGED" : null;
  switch (p.status) {
    case "READY_FOR_REVIEW":
      return "READY";
    case "NEEDS_ATTENTION":
      return "ATTENTION";
    case "PREPARATION_FAILED":
      return "FAILED";
    case "SEND_FAILED":
      return "SEND_FAILED";
    default:
      return null; // PREPARING, SENDING: nothing for the owner to do yet
  }
}

/** The value stored in AccountantPeriod.notifiedStatus for a notice. */
export function notifiedStatusFor(kind: NoticeKind): string {
  return kind === "READY"
    ? "READY_FOR_REVIEW"
    : kind === "ATTENTION"
      ? "NEEDS_ATTENTION"
      : kind === "FAILED"
        ? "PREPARATION_FAILED"
        : kind === "SEND_FAILED"
          ? "SEND_FAILED"
          : "CHANGED_AFTER_SEND";
}

export function periodHref(periodKey: PeriodKey): string {
  return `/documents/accountant-pack?period=${periodKey}`;
}

function attentionSummary(r: StoredReadiness | null): string {
  const parts: string[] = [];
  for (const b of r?.blockers ?? []) {
    if (b.kind === "DOCUMENTS_PENDING_REVIEW") parts.push(`${b.count} מסמכים ממתינים לבדיקה`);
    else if (b.kind === "ISSUED_PDF_UNAVAILABLE") parts.push(`${b.count} מסמכים שהופקו ללא קובץ סופי`);
    else parts.push(`${b.count} קבצים חסרים`);
  }
  return parts.length > 0 ? parts.join(" · ") : "יש פריטים שדורשים את תשומת לבך";
}

function readySummary(r: StoredReadiness | null): string {
  const c = r?.counts;
  if (!c) return "אפשר לעבור על החבילה ולשלוח אותה לרואה החשבון";
  const scanned = c.scannedExpense + c.scannedIncome;
  return `${scanned} מסמכים סרוקים · ${c.issued} מסמכים שהופקו — אפשר לעבור על החבילה ולשלוח`;
}

/** The status item for a notice — the same shape every other domain produces. */
export function translatePeriodNotice(input: PeriodNoticeInput, kind: NoticeKind, now: Date): BusinessStatusItemBuild {
  const month = monthNameHe(input.periodKey);
  const href = periodHref(input.periodKey);
  const base = {
    domain: "documents" as const,
    state: "open" as const,
    createdAt: now.toISOString(),
    sourceEngine: "accountant-month-close",
    blocking: false,
    priorityReferenceDate: now,
    entityRef: { type: ACCOUNTANT_ENTITY_TYPES[kind], id: input.periodId },
    itemId: `documents:${ACCOUNTANT_ENTITY_TYPES[kind]}:${input.periodId}`,
  };
  switch (kind) {
    case "READY":
      return {
        ...base,
        semanticCategory: "ACTION_REQUIRED",
        severity: "MEDIUM",
        title: `הקובץ לרואה החשבון עבור חודש ${month} מוכן לבדיקה ולשליחה.`,
        summary: readySummary(input.readiness),
        primaryAction: { kind: "navigate", label: "לבדיקה ושליחה", href },
      };
    case "ATTENTION": {
      const open = openItemsOfStored(input.readiness);
      return {
        ...base,
        semanticCategory: "ACTION_REQUIRED",
        severity: "MEDIUM",
        title: `הקובץ לרואה החשבון עבור חודש ${month} עדיין לא שלם — ${open} פריטים פתוחים`,
        summary: attentionSummary(input.readiness),
        primaryAction: { kind: "navigate", label: "מה חסר", href },
      };
    }
    case "FAILED":
      return {
        ...base,
        semanticCategory: "ACTION_REQUIRED",
        severity: "MEDIUM",
        title: `לא הצלחנו להכין את הקובץ לרואה החשבון עבור חודש ${month}`,
        summary: "ננסה שוב אוטומטית. אפשר גם לנסות עכשיו מתוך המסך.",
        primaryAction: { kind: "navigate", label: "לפרטים", href },
      };
    case "SEND_FAILED":
      return {
        ...base,
        semanticCategory: "FAILURE_EVENT",
        severity: "HIGH",
        title: `השליחה לרואה החשבון עבור חודש ${month} נכשלה`,
        summary: "הקובץ לא נמסר. אפשר לבדוק את כתובת המייל ולשלוח שוב.",
        primaryAction: { kind: "navigate", label: "לפרטים", href },
      };
    case "CHANGED":
      return {
        ...base,
        semanticCategory: "ACTION_REQUIRED",
        severity: "MEDIUM",
        title: `נוספו נתונים לחודש ${month} אחרי שהקובץ נשלח לרואה החשבון`,
        summary: "הכנו גרסה מעודכנת. היא לא תישלח בלי אישור שלך.",
        primaryAction: { kind: "navigate", label: "לגרסה המעודכנת", href },
      };
  }
}

function dedupeKeyFor(businessId: number, kind: NoticeKind, periodId: number): string {
  const semanticCategory = kind === "SEND_FAILED" ? "FAILURE_EVENT" : "ACTION_REQUIRED";
  return buildDedupeKey(businessId, {
    domain: "documents",
    semanticCategory,
    entityRef: { type: ACCOUNTANT_ENTITY_TYPES[kind], id: periodId },
  });
}

export type ReminderDecision = { remind: boolean; reason: string };

/**
 * Whether a reminder is due (pure). `now` decides by the Jerusalem calendar; reminders exist only for the
 * most recently closed month and only while the same notice is still the current one.
 */
export function reminderDue(input: {
  periodKey: PeriodKey;
  status: PeriodStatus;
  notifiedStatus: string | null;
  notifiedAt: Date | null;
  lastReminderAt: Date | null;
  remindersSent: number;
  now: Date;
}): ReminderDecision {
  if (input.periodKey !== previousPeriodKey(input.now)) return { remind: false, reason: "not_latest_period" };
  if (!OWNER_ACTION_STATUSES.has(input.status)) return { remind: false, reason: "no_owner_action" };
  if (input.notifiedAt === null || input.notifiedStatus === null) return { remind: false, reason: "never_notified" };
  if (input.remindersSent >= REMINDER_DAYS.length) return { remind: false, reason: "reminders_exhausted" };
  const day = jerusalemDayOfMonth(input.now);
  if (day < REMINDER_DAYS[input.remindersSent]) return { remind: false, reason: "not_yet" };
  const last = Math.max(input.notifiedAt.getTime(), input.lastReminderAt?.getTime() ?? 0);
  if (input.now.getTime() - last < MIN_REMINDER_GAP_MS) return { remind: false, reason: "too_soon" };
  return { remind: true, reason: `day_${REMINDER_DAYS[input.remindersSent]}` };
}

export type NoticeSyncOutcome = { notice: NoticeKind | null; surfaced: boolean; reminded: boolean; resolved: number };

/**
 * Brings the notification centre in line with the period: the current notice is written (or refreshed)
 * when the state changed or a reminder is due; every other notice of the period is resolved. Never
 * throws — the period is already persisted, and a notification failure must not undo or repeat it.
 */
export async function syncPeriodNotice(
  period: {
    businessId: number;
    id: number;
    periodKey: PeriodKey;
    status: string;
    changedSinceSent: boolean;
    readiness: unknown;
    notifiedStatus: string | null;
    notifiedAt: Date | null;
    lastReminderAt: Date | null;
    remindersSent: number;
  },
  now: Date
): Promise<NoticeSyncOutcome> {
  try {
    const status = period.status as PeriodStatus;
    const kind = noticeKindFor({ status, changedSinceSent: period.changedSinceSent });
    let resolved = 0;
    for (const k of Object.keys(ACCOUNTANT_ENTITY_TYPES) as NoticeKind[]) {
      if (k === kind) continue;
      if (await resolveNotificationByDedupeKey(period.businessId, dedupeKeyFor(period.businessId, k, period.id), now)) {
        resolved += 1;
      }
    }
    if (!kind) {
      if (period.notifiedStatus !== null) {
        await tenantTx(period.businessId, (tx) =>
          tx.accountantPeriod.updateMany({
            where: { id: period.id, businessId: period.businessId },
            data: { notifiedStatus: null, updatedAt: now },
          })
        );
      }
      return { notice: null, surfaced: false, reminded: false, resolved };
    }

    const wanted = notifiedStatusFor(kind);
    const isNew = period.notifiedStatus !== wanted;
    const reminder = isNew
      ? { remind: false, reason: "new_notice" }
      : reminderDue({
          periodKey: period.periodKey,
          status,
          notifiedStatus: period.notifiedStatus,
          notifiedAt: period.notifiedAt,
          lastReminderAt: period.lastReminderAt,
          remindersSent: period.remindersSent,
          now,
        });
    if (!isNew && !reminder.remind) {
      // Keep the stored copy current (counts change) without surfacing it again.
      return { notice: kind, surfaced: false, reminded: false, resolved };
    }

    const item = finalizeBusinessStatusItem(
      translatePeriodNotice(
        {
          businessId: period.businessId,
          periodId: period.id,
          periodKey: period.periodKey,
          status,
          changedSinceSent: period.changedSinceSent,
          readiness: parseStoredReadiness(period.readiness),
        },
        kind,
        now
      )
    );
    const written = await persistSnapshotNotifications(period.businessId, [item], now);
    const surfaced = written.some((w) => w.notified);

    await tenantTx(period.businessId, async (tx) => {
      await tx.accountantPeriod.updateMany({
        where: { id: period.id, businessId: period.businessId },
        data: isNew
          ? { notifiedStatus: wanted, notifiedAt: now, remindersSent: 0, lastReminderAt: null, updatedAt: now }
          : { remindersSent: { increment: 1 }, lastReminderAt: now, updatedAt: now },
      });
      await appendEvent(tx, {
        businessId: period.businessId,
        periodId: period.id,
        eventType: isNew ? "NOTIFIED" : "REMINDED",
        actor: { type: "SYSTEM" },
        occurredAt: now,
        payload: { notice: kind, surfaced, ...(isNew ? {} : { reminder: period.remindersSent + 1 }) },
        idempotencyKey: isNew
          ? `notice:${period.id}:${wanted}:${now.getTime()}`
          : `remind:${period.id}:${wanted}:${period.remindersSent + 1}`,
      });
    });
    return { notice: kind, surfaced, reminded: !isNew, resolved };
  } catch (error) {
    console.error("[accountant] notice sync failed", {
      businessId: period.businessId,
      periodId: period.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { notice: null, surfaced: false, reminded: false, resolved: 0 };
  }
}
