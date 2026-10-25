/**
 * Commitment detail screen — what to show, never what anything is worth.
 *
 * Pure: no React, no network, no clock. Every amount here is a string the
 * server already derived (`remaining`, `scheduled`, `total`, `paid`); this
 * module only PICKS among them and orders rows. It never adds, subtracts or
 * rounds money (see lib/payables/payables-client.ts).
 */

import type {
  ChequeApi,
  ChequeStatus,
  CommitmentDetailApi,
  DerivedState,
  InstallmentApi,
  PaymentApi,
  PreparationApi,
  PreparationStatus,
} from "@/lib/payables/payables-client";

/* ───────────────────────────── the current payment ───────────────────────── */

/**
 * The installment the owner should look at now. The SAME rule the server uses
 * for the list's `next` (lib/services/payables/payables-read.ts): the earliest
 * due installment that still wants something; a cancelled one wants nothing.
 * Keeping it identical means the row in the list and the box on this screen
 * always name the same payment.
 */
export function pickCurrentInstallment(installments: InstallmentApi[]): InstallmentApi | null {
  const open = installments
    .filter((i) => Number(i.remaining) > 0 && i.state !== "CANCELLED")
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  return open[0] ?? null;
}

/**
 * Installments the existing payment / preparation / cheque forms accept — the
 * exact filter those forms apply themselves. The action buttons show only when
 * this is non-empty, so a button never opens onto "nothing to pay".
 */
export function payableInstallments(installments: InstallmentApi[]): InstallmentApi[] {
  return installments.filter((i) => Number(i.remaining) > 0 && i.status === "SCHEDULED");
}

/* ───────────────────────────── the status box ───────────────────────────── */

export type HeroKind =
  /** An installment is open and not late. */
  | "OPEN"
  /** The current installment is overdue. */
  | "OVERDUE"
  /** Nothing open and money was recorded against it. */
  | "PAID"
  /** Ended (an end date was set) or closed, nothing left open. */
  | "ENDED"
  /** Only a pre-ledger "handled" assertion — never "paid". */
  | "LEGACY"
  /** Released by the owner: not relevant any more. */
  | "RELEASED"
  /** Every installment was cancelled. */
  | "CANCELLED"
  /** Nothing open, nothing recorded. */
  | "NONE";

export type Hero = {
  kind: HeroKind;
  /** The installment the box is about, when there is one. */
  installment: InstallmentApi | null;
  /** The most recent recorded (not voided) payment, for "שולם ב־". */
  lastPayment: PaymentApi | null;
};

export function heroOf(detail: Pick<CommitmentDetailApi, "installments" | "payments" | "status" | "endAt">): Hero {
  const current = pickCurrentInstallment(detail.installments);
  const recorded = detail.payments
    .filter((p) => p.status === "RECORDED")
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
  const lastPayment = recorded[0] ?? null;

  if (current) {
    return { kind: current.state === "OVERDUE" ? "OVERDUE" : "OPEN", installment: current, lastPayment };
  }
  // Nothing open. Same vocabulary as the list's closed rows (payables-list-model
  // closedKindOf), with the end date winning so an ended series says so.
  if (detail.status === "RELEASED") return { kind: "RELEASED", installment: null, lastPayment };
  if (detail.endAt) return { kind: "ENDED", installment: null, lastPayment };
  if (detail.installments.some((i) => i.state === "PAID")) return { kind: "PAID", installment: null, lastPayment };
  const legacy = detail.installments.find((i) => i.state === "SETTLED_LEGACY") ?? null;
  if (legacy) return { kind: "LEGACY", installment: legacy, lastPayment };
  if (detail.installments.length > 0 && detail.installments.every((i) => i.state === "CANCELLED")) {
    return { kind: "CANCELLED", installment: null, lastPayment };
  }
  if (detail.status === "CLOSED") return { kind: "ENDED", installment: null, lastPayment };
  return { kind: "NONE", installment: null, lastPayment };
}

export const HERO_TITLE: Record<HeroKind, string> = {
  OPEN: "התשלום הקרוב",
  OVERDUE: "תשלום באיחור",
  PAID: "שולם במלואו",
  ENDED: "ההתחייבות הסתיימה",
  LEGACY: "סומן כטופל",
  RELEASED: "לא רלוונטי",
  CANCELLED: "בוטל",
  NONE: "אין תשלום פתוח",
};

/** True when the installment carries a partial payment — shown as "נותרו X מתוך Y". */
export function isPartlyPaid(i: Pick<InstallmentApi, "paid" | "remaining">): boolean {
  return Number(i.paid) > 0 && Number(i.remaining) > 0;
}

/* ───────────────────────────── the schedule ─────────────────────────────── */

/**
 * Rows in reading order: what still wants something first (earliest due
 * first, so the current payment heads the list), then everything settled,
 * cancelled or handled, most recent first.
 */
export function orderSchedule(installments: InstallmentApi[]): InstallmentApi[] {
  const time = (i: InstallmentApi) => new Date(i.dueAt).getTime();
  const isOpen = (i: InstallmentApi) => Number(i.remaining) > 0 && i.state !== "CANCELLED";
  const open = installments.filter(isOpen).sort((a, b) => time(a) - time(b) || a.sequence - b.sequence);
  const rest = installments.filter((i) => !isOpen(i)).sort((a, b) => time(b) - time(a) || b.sequence - a.sequence);
  return [...open, ...rest];
}

/** Rows visible before "הצג הכל", per layout. */
export const SCHEDULE_PREVIEW = { mobile: 4, tablet: 6, desktop: 8 } as const;

/* ───────────────────────────── cheques / preparations ───────────────────── */

/** A cheque still in motion; the rest are history (cleared, bounced, cancelled, replaced). */
const OPEN_CHEQUE: ReadonlySet<ChequeStatus> = new Set(["PLANNED", "ISSUED", "DELIVERED", "PRESENTED"]);

export function chequeCounts(cheques: Pick<ChequeApi, "status">[]): { open: number; total: number } {
  return { open: cheques.filter((c) => OPEN_CHEQUE.has(c.status)).length, total: cheques.length };
}

/** "2 צ׳קים פתוחים · 3 בסך הכל" — exact, and empty when there are none. */
export function chequeCountLabel(cheques: Pick<ChequeApi, "status">[]): string {
  const { open, total } = chequeCounts(cheques);
  if (total === 0) return "";
  const openText = open === 1 ? "צ׳ק פתוח אחד" : `${open} צ׳קים פתוחים`;
  const totalText = total === 1 ? "צ׳ק אחד" : `${total} צ׳קים`;
  if (open === 0) return totalText;
  if (open === total) return openText;
  return `${openText} · ${total} בסך הכל`;
}

/** A preparation the owner still has to act on. */
const OPEN_PREPARATION: ReadonlySet<PreparationStatus> = new Set(["PREPARED", "APPROVED", "SUBMITTED"]);

export function openPreparations(preparations: PreparationApi[]): PreparationApi[] {
  return preparations.filter((p) => OPEN_PREPARATION.has(p.status));
}

export function openPreparationsLabel(count: number): string {
  if (count === 0) return "";
  return count === 1 ? "תשלום מוכן אחד ממתין לטיפול שלך" : `${count} תשלומים מוכנים ממתינים לטיפול שלך`;
}

/* ───────────────────────────── history wording ──────────────────────────── */

/**
 * The audit trail is written by the server in English (payables_audit_event
 * .summary). The owner reads a Hebrew label per event TYPE; the original
 * summary is kept verbatim behind "פרטים טכניים". Nothing is rewritten.
 */
export const AUDIT_LABEL: Record<string, string> = {
  ALLOCATION_CREATED: "סכום שויך לתשלום",
  ALLOCATION_REVERSED: "שיוך בוטל",
  BANK_ACCOUNT_ARCHIVED: "חשבון בנק הועבר לארכיון",
  BANK_ACCOUNT_CREATED: "נוסף חשבון בנק",
  BANK_ACCOUNT_DEFAULT_SET: "נקבע חשבון בנק ברירת מחדל",
  BANK_ACCOUNT_RESTORED: "חשבון בנק שוחזר",
  BANK_ACCOUNT_UPDATED: "פרטי חשבון בנק עודכנו",
  CHEQUE_ADVANCED: "מצב הצ׳ק עודכן",
  CHEQUE_BOUNCED: "הצ׳ק חזר",
  CHEQUE_CANCELLED: "הצ׳ק בוטל",
  CHEQUE_CLEARED_OWNER_ASSERTED: "סומן שהצ׳ק נפרע",
  CHEQUE_CREATED: "נרשם צ׳ק",
  CHEQUE_REPLACED: "הצ׳ק הוחלף",
  COMMITMENT_CREATED: "ההתחייבות נוצרה",
  COMMITMENT_ENDED: "נקבע מועד סיום להתחייבות",
  COMMITMENT_MIGRATED_FROM_OBLIGATION: "ההתחייבות הועברה מהמזכירה",
  COMMITMENT_SYNCED_FROM_OBLIGATION: "עודכנו פרטים מהרשומה המקורית במזכירה",
  COMMITMENT_UPDATED: "פרטי ההתחייבות עודכנו",
  DESTINATION_ARCHIVED: "חשבון של המוטב הועבר לארכיון",
  DESTINATION_CREATED: "נוסף חשבון למוטב",
  DESTINATION_DEFAULT_SET: "נקבע חשבון ברירת מחדל למוטב",
  DESTINATION_REPLACED: "חשבון של המוטב הוחלף",
  DESTINATION_RESTORED: "חשבון של המוטב שוחזר",
  DESTINATION_REVEALED: "הוצגו פרטי החשבון המלאים של המוטב",
  DOCUMENT_EVIDENCE_ATTACHED: "מסמך צורף כאסמכתא לתשלום",
  DOCUMENT_EVIDENCE_REVOKED: "מסמך הוסר מתשלום",
  DOCUMENT_MATCH_REJECTED: "התאמת מסמך נדחתה",
  EVIDENCE_REVOKED: "אסמכתא הוסרה מתשלום",
  EXECUTION_FAILED: "ביצוע התשלום נכשל, לא שולם דבר",
  EXECUTION_REQUESTED: "נשלחה בקשה לביצוע תשלום (טרם שולם)",
  EXECUTION_SETTLED: "ספק התשלומים דיווח שהתשלום בוצע",
  EXECUTION_UPDATED: "עדכון מספק התשלומים (טרם שולם)",
  EXTERNAL_EVIDENCE_REVOKED: "אסמכתא הוסרה מתשלום",
  EXTERNAL_TRANSACTIONS_INGESTED: "נקלטו תנועות בנק",
  EXTERNAL_TRANSACTION_ATTACHED: "תנועת בנק שויכה לתשלום",
  EXTERNAL_TRANSACTION_DISMISSED: "תנועת בנק סומנה כלא תשלום לספק",
  EXTERNAL_TRANSACTION_REJECTED: "הצעת שיוך לתנועת בנק נדחתה",
  INSTALLMENT_AMOUNT_CHANGED: "סכום תשלום שונה",
  INSTALLMENT_CANCELLED: "תשלום בוטל",
  INSTALLMENT_CREATED: "נוצר התשלום הבא בסדרה",
  OBLIGATION_CHANGED: "ההתחייבות עודכנה",
  PAYEE_CREATED: "נוצר מוטב",
  PAYMENT_RECORDED: "נרשם תשלום",
  PAYMENT_RECORDED_FROM_DOCUMENT: "נרשם תשלום ממסמך",
  PAYMENT_VOIDED: "רישום תשלום בוטל",
  PREPARATION_APPROVED: "תשלום מוכן אושר (טרם שולם)",
  PREPARATION_CANCELLED: "תשלום מוכן בוטל",
  PREPARATION_COMPLETED: "תשלום מוכן סומן כבוצע",
  PREPARATION_CREATED: "הוכן תשלום (טרם שולם)",
};

/** Known server sentences that deserve a more specific label than their type. */
const AUDIT_SUMMARY_LABEL: Array<[RegExp, string]> = [
  [/^Recurring commitment total cleared/, "התאמה למבנה של התחייבות מתחדשת: הוסר סכום כולל שהועבר מהמערכת הקודמת"],
  [/^Installment cancelled — the commitment ends/, "תשלום בוטל בעקבות סיום ההתחייבות"],
  [/^Payment voided — cheque #.* bounced/, "רישום התשלום בוטל כי הצ׳ק חזר"],
];

export const AUDIT_FALLBACK_LABEL = "פעולה במערכת";
const MIGRATION_PREFIX = "העברה מהמזכירה: ";

export function auditLabel(event: { eventType: string; source: string; summary: string | null }): string {
  const bySummary = event.summary ? AUDIT_SUMMARY_LABEL.find(([re]) => re.test(event.summary!))?.[1] : undefined;
  const label = bySummary ?? AUDIT_LABEL[event.eventType] ?? AUDIT_FALLBACK_LABEL;
  if (event.source === "MIGRATION" && !label.includes("מזכירה")) return MIGRATION_PREFIX + label;
  return label;
}

/* ───────────────────────────── badges ───────────────────────────── */

/** Badge tone per derived state; the WORDS stay the money dictionary's `state` labels. */
export const STATE_TONE: Record<DerivedState, "overdue" | "due" | "partial" | "paid" | "quiet"> = {
  OVERDUE: "overdue",
  DUE: "due",
  PARTIALLY_PAID: "partial",
  PAID: "paid",
  SCHEDULED: "quiet",
  CANCELLED: "quiet",
  SETTLED_LEGACY: "quiet",
};
