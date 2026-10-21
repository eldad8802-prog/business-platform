/**
 * The Secretary home, derived from the server briefing (GET
 * /api/obligations/briefing). Pure — no React, no fetch — so the wording can be
 * proven against real briefings (`npm run verify:secretary-home`).
 *
 * Rules:
 *   - Every count comes from the server: the briefing's `attention` items and
 *     their `reason` (OVERDUE / DUE_TODAY / DUE_SOON) and its `watching` list.
 *     Nothing here decides what is overdue.
 *   - The headline is built from those counts, so it can never say "one thing"
 *     next to three overdue rows.
 *   - No money is summed here. Each row carries the server's own figures:
 *     `ledger.remaining` (what is still owed) when the item is ledger-backed,
 *     the scheduled `amount` otherwise. Totals live in the business-cost card,
 *     which comes from the cost engine.
 */

import type { AttentionReason, BriefingApi, ObligationApi, RecurrenceCadence } from "@/lib/obligations/secretary-client";

export type HomeGroupKey = "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "WATCHING";

export type HomeRow = {
  obligation: ObligationApi;
  status: AttentionReason | "WATCHING";
  name: string;
  /** The figure the row leads with: what is still owed when known. */
  amount: string;
  /** "נותר" when `amount` is the ledger remaining. */
  amountCaption: string | null;
  /** Paid out of scheduled, when something was already paid (both from the server). */
  progress: { paid: string; total: string } | null;
  cadence: string;
  /** Can the existing payment path record a payment for this row? */
  canRecordPayment: boolean;
  commitmentId: number | null;
};

export type HomeGroup = { key: HomeGroupKey; title: string; rows: HomeRow[] };

export type SecretaryHomeView = {
  state: "new" | "attention" | "calm";
  title: string;
  subtitle: string;
  counts: { overdue: number; today: number; soon: number; watching: number; open: number };
  groups: HomeGroup[];
  /** True when the items are payables-ledger installments (Prod today). */
  ledgerBacked: boolean;
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

export function cadenceText(value: RecurrenceCadence): string {
  return CADENCE_TEXT[value] ?? CADENCE_TEXT.NONE;
}

export function displayObligeeName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
}

const GROUP_TITLE: Record<HomeGroupKey, string> = {
  OVERDUE: "עבר המועד",
  DUE_TODAY: "להיום",
  DUE_SOON: "בשבוע הקרוב",
  WATCHING: "במעקב שקט",
};

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
    cadence: cadenceText(o.recurrence),
    canRecordPayment: Boolean(ledger && Number(ledger.remaining) > 0),
    commitmentId: ledger ? ledger.commitmentId : null,
  };
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

  const counts = {
    overdue: overdue.length,
    today: today.length,
    soon: soon.length,
    watching: watching.length,
    open: briefing.counts.open,
  };

  const groups: HomeGroup[] = (
    [
      ["OVERDUE", overdue],
      ["DUE_TODAY", today],
      ["DUE_SOON", soon],
      ["WATCHING", watching],
    ] as Array<[HomeGroupKey, HomeRow[]]>
  )
    .filter(([, rows]) => rows.length > 0)
    .map(([key, rows]) => ({ key, title: GROUP_TITLE[key], rows }));

  const ledgerBacked = [...briefing.attention.map((a) => a.obligation), ...briefing.watching].some((o) => Boolean(o.ledger));

  if (briefing.counts.open === 0) {
    return {
      state: "new",
      title: "שלום, אני המזכירה שלך.",
      subtitle: "מוסרים לי את התשלומים שהעסק צריך להוציא, ואני מציגה כל אחד מהם כאן כשהוא מתקרב.",
      counts,
      groups,
      ledgerBacked,
    };
  }

  const rest = (parts: Array<string | false>) => parts.filter(Boolean).join(" · ");

  if (counts.overdue > 0) {
    return {
      state: "attention",
      title: counts.overdue === 1 ? "תשלום אחד עבר את המועד." : `${counts.overdue.toLocaleString("he-IL")} תשלומים עברו את המועד.`,
      subtitle:
        rest([
          counts.today > 0 && phrase(counts.today, "עוד אחד להיום", "להיום"),
          counts.soon > 0 && phrase(counts.soon, "אחד בשבוע הקרוב", "בשבוע הקרוב"),
          counts.watching > 0 && phrase(counts.watching, "אחד במעקב שקט", "במעקב שקט"),
        ]) || "נתחיל מהם.",
      counts,
      groups,
      ledgerBacked,
    };
  }

  if (counts.today > 0) {
    return {
      state: "attention",
      title: counts.today === 1 ? "תשלום אחד מחכה להיום." : `${counts.today.toLocaleString("he-IL")} תשלומים מחכים להיום.`,
      subtitle:
        rest([
          counts.soon > 0 && phrase(counts.soon, "אחד בשבוע הקרוב", "בשבוע הקרוב"),
          counts.watching > 0 && phrase(counts.watching, "אחד במעקב שקט", "במעקב שקט"),
        ]) || "זה כל מה שדורש אותך היום.",
      counts,
      groups,
      ledgerBacked,
    };
  }

  if (counts.soon > 0) {
    return {
      state: "attention",
      title: counts.soon === 1 ? "תשלום אחד מתקרב השבוע." : `${counts.soon.toLocaleString("he-IL")} תשלומים מתקרבים השבוע.`,
      subtitle: counts.watching > 0 ? phrase(counts.watching, "ועוד אחד במעקב שקט.", "נוספים במעקב שקט.") : "אין תשלום שעבר את המועד.",
      counts,
      groups,
      ledgerBacked,
    };
  }

  // Nothing needs the owner this week. "הכול רגוע" is only said once the owner
  // confirmed every fixed cost is recorded (briefing.oriented); before that the
  // calm is scoped to what was recorded.
  return {
    state: "calm",
    title: briefing.oriented ? "הכול רגוע השבוע." : "אין תשלום שדורש אותך השבוע.",
    subtitle: briefing.oriented
      ? `${phrase(counts.watching, "התחייבות אחת במעקב", "התחייבויות במעקב")}. כל אחת תופיע כאן שבוע לפני המועד שלה.`
      : "זה לפי מה שנמסר לי עד עכשיו. כדאי לוודא שכל ההוצאות הקבועות רשומות.",
    counts,
    groups,
    ledgerBacked,
  };
}
