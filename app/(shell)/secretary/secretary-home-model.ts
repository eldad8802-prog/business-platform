/**
 * The Secretary's main screen, derived from the server briefing
 * (GET /api/obligations/briefing). Pure — no React, no fetch — so the wording
 * is proven against real briefings (`npm run verify:secretary-home`).
 *
 * Rules:
 *   - Every count comes from the server: `attention[].reason`
 *     (OVERDUE / DUE_TODAY / DUE_SOON) and `watching`. Nothing here decides
 *     what is overdue.
 *   - The headline is built from those counts, so it can never say "one
 *     thing" beside three overdue rows.
 *   - No money is summed or rounded here. A row leads with the server's own
 *     `ledger.remaining` when the item is ledger-backed (what is still owed),
 *     and the scheduled `amount` otherwise.
 *   - No sentence promises a reminder: nothing sends one.
 */

import type { AttentionReason, BriefingApi, ObligationApi, RecurrenceCadence } from "@/lib/obligations/secretary-client";
import { daysBetweenDayKeys, jerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type HomeGroupKey = "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "WATCHING";

export type HomeRow = {
  obligation: ObligationApi;
  status: AttentionReason | "WATCHING";
  name: string;
  /** The figure the row leads with (server string, never recomputed). */
  amount: string;
  /** "נותר" when `amount` is the ledger remaining. */
  amountCaption: string | null;
  /** Paid out of scheduled, both server strings, when part is already paid. */
  progress: { paid: string; total: string } | null;
  cadence: string;
};

export type HomeGroup = { key: HomeGroupKey; title: string; rows: HomeRow[] };

export type SecretaryHomeView = {
  state: "new" | "attention" | "calm";
  title: string;
  subtitle: string;
  counts: { overdue: number; today: number; soon: number; watching: number; open: number };
  /** Items that need the owner, in the server's order, grouped by its reason. */
  needs: HomeGroup[];
  /** Quiet tracking (briefing.watching). */
  watching: HomeRow[];
};

const CADENCE_TEXT: Record<RecurrenceCadence, string> = {
  NONE: "חד-פעמי",
  WEEKLY: "כל שבוע",
  MONTHLY: "כל חודש",
  BIMONTHLY: "כל חודשיים",
  QUARTERLY: "כל רבעון",
  SEMIANNUAL: "כל חצי שנה",
  YEARLY: "כל שנה",
};

/** The Secretary's existing badge wording (page.tsx dueBadge + "במעקב"). */
export const STATUS_LABEL: Record<HomeRow["status"], string> = {
  OVERDUE: "באיחור",
  DUE_TODAY: "להיום",
  DUE_SOON: "מתקרב",
  WATCHING: "במעקב",
};

const GROUP_TITLE: Record<HomeGroupKey, string> = {
  OVERDUE: "עבר המועד",
  DUE_TODAY: "להיום",
  DUE_SOON: "בשבוע הקרוב",
  WATCHING: "במעקב שקט",
};

export function displayObligeeName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
}

export function rowFromObligation(o: ObligationApi, status: HomeRow["status"]): HomeRow {
  const ledger = o.ledger ?? null;
  const paidSomething = ledger ? Number(ledger.paid) > 0 : false;
  return {
    obligation: o,
    status,
    name: displayObligeeName(o.obligeeName),
    amount: ledger ? ledger.remaining : o.amount,
    amountCaption: ledger ? "נותר" : null,
    progress: ledger && paidSomething ? { paid: ledger.paid, total: o.amount } : null,
    cadence: CADENCE_TEXT[o.recurrence] ?? CADENCE_TEXT.NONE,
  };
}

/** Whole Israel calendar days from today to the due day (negative = past). */
export function dueDays(dueAt: string, now: Date): number | null {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  return daysBetweenDayKeys(jerusalemDayKey(now), jerusalemDayKey(due));
}

/** "היום" · "מחר" · "לפני 36 ימים" · "בעוד 69 ימים". */
export function relativeDays(days: number): string {
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  if (days === -1) return "אתמול";
  if (days === 2) return "בעוד יומיים";
  if (days === -2) return "לפני יומיים";
  return days > 0 ? `בעוד ${days} ימים` : `לפני ${-days} ימים`;
}

function phrase(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n.toLocaleString("he-IL")} ${many}`;
}

export function buildSecretaryHome(briefing: BriefingApi): SecretaryHomeView {
  const byReason = (reason: AttentionReason) =>
    briefing.attention.filter((item) => item.reason === reason).map((item) => rowFromObligation(item.obligation, reason));

  const overdue = byReason("OVERDUE");
  const today = byReason("DUE_TODAY");
  const soon = byReason("DUE_SOON");
  const watching = briefing.watching.map((o) => rowFromObligation(o, "WATCHING"));
  const counts = { overdue: overdue.length, today: today.length, soon: soon.length, watching: watching.length, open: briefing.counts.open };

  const needs: HomeGroup[] = (
    [
      ["OVERDUE", overdue],
      ["DUE_TODAY", today],
      ["DUE_SOON", soon],
    ] as Array<[HomeGroupKey, HomeRow[]]>
  )
    .filter(([, rows]) => rows.length > 0)
    .map(([key, rows]) => ({ key, title: GROUP_TITLE[key], rows }));

  if (briefing.counts.open === 0) {
    return {
      state: "new",
      title: "שלום, אני המזכירה שלך.",
      subtitle: "מוסרים לי את התשלומים שהעסק צריך להוציא, ואני מציגה כל אחד מהם כאן כשהוא מתקרב.",
      counts,
      needs,
      watching,
    };
  }

  const tail = (parts: Array<string | false>) => {
    const list = parts.filter(Boolean) as string[];
    return list.length > 0 ? `ועוד ${list.join(" · ")}. כל השאר שמור אצלי.` : "כל השאר שמור אצלי.";
  };

  if (counts.overdue > 0) {
    return {
      state: "attention",
      title: counts.overdue === 1 ? "תשלום אחד עבר את המועד." : `${counts.overdue.toLocaleString("he-IL")} תשלומים עברו את המועד.`,
      subtitle: tail([
        counts.today > 0 && phrase(counts.today, "אחד להיום", "להיום"),
        counts.soon > 0 && phrase(counts.soon, "אחד בשבוע הקרוב", "בשבוע הקרוב"),
        counts.watching > 0 && phrase(counts.watching, "אחד במעקב שקט", "במעקב שקט"),
      ]),
      counts,
      needs,
      watching,
    };
  }

  if (counts.today > 0) {
    return {
      state: "attention",
      title: counts.today === 1 ? "תשלום אחד מחכה להיום." : `${counts.today.toLocaleString("he-IL")} תשלומים מחכים להיום.`,
      subtitle: tail([
        counts.soon > 0 && phrase(counts.soon, "אחד בשבוע הקרוב", "בשבוע הקרוב"),
        counts.watching > 0 && phrase(counts.watching, "אחד במעקב שקט", "במעקב שקט"),
      ]),
      counts,
      needs,
      watching,
    };
  }

  if (counts.soon > 0) {
    return {
      state: "attention",
      title: counts.soon === 1 ? "תשלום אחד מתקרב השבוע." : `${counts.soon.toLocaleString("he-IL")} תשלומים מתקרבים השבוע.`,
      subtitle: tail([counts.watching > 0 && phrase(counts.watching, "אחד במעקב שקט", "במעקב שקט")]),
      counts,
      needs,
      watching,
    };
  }

  // Nothing needs the owner this week. "הכול רגוע" only once the owner
  // confirmed every fixed cost is recorded (briefing.oriented); before that the
  // calm is scoped to what was handed over.
  return {
    state: "calm",
    title: briefing.oriented ? "הכול רגוע השבוע." : "אין תשלום שדורש אותך השבוע.",
    subtitle: briefing.oriented
      ? `${phrase(counts.watching, "התחייבות אחת במעקב", "התחייבויות במעקב")}. כשמועד מתקרב, הוא יופיע כאן.`
      : "זה לפי מה שנמסר לי עד עכשיו. כדאי לוודא שכל ההוצאות הקבועות רשומות.",
    counts,
    needs,
    watching,
  };
}

const HEBREW = /[֐-׿]/;

/** A failure message for the owner: the server's own text if it is Hebrew, else ours. */
export function ownerErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  return raw && HEBREW.test(raw) ? raw : fallback;
}
