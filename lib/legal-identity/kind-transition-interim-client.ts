/**
 * "מעבר לעוסק מורשה" — the interim documents shown on the screens (4a T4; contract .billing-4a/T4-INTERIM-DOCUMENTS-CONTRACT.md).
 *
 * The documents issued as an exempt dealer between the official status date and the update in Dubiz. The count and the
 * list come from 4a's read-only route; this file only calls it and words the answer. The number the owner saw is sent
 * with the confirmation, and the server counts again inside the transition's own transaction: if it changed, nothing
 * is written and the screen shows the new number (409 INTERIM_DOCUMENTS_CHANGED).
 */

export const INTERIM_DOCUMENTS_API = "/api/billing/kind-transition/interim-documents";

export type InterimCreditState = "NONE" | "PARTIAL" | "FULL" | "LINKED";
export type InterimItem = {
  id: number;
  documentType: "TAX_INVOICE" | "TAX_INVOICE_RECEIPT" | "RECEIPT" | "CREDIT_NOTE";
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  issuedAt: string;
  documentDate: string;
  totalAmount: string;
  currency: string;
  creditState: InterimCreditState;
  creditedAmount: string;
};
export type InterimAnswer = {
  range: { fromDate: string; to: string; timezone: string; toExclusive: boolean; source: "REQUEST" | "TRANSITION_RECORD" };
  count: number;
  credit: { full: number; partial: number; linked: number };
  items?: InterimItem[];
  nextCursor?: string | null;
};

function token(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

/** The query string: `from` only while there is no transition (the success screen asks without it). */
export function interimQuery(args: { from?: string | null; list?: boolean; cursor?: string | null }): string {
  const q = new URLSearchParams();
  if (args.from) q.set("from", args.from);
  if (args.list) q.set("list", "1");
  if (args.cursor) q.set("cursor", args.cursor);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type InterimFetch = { ok: true; answer: InterimAnswer } | { ok: false; status: number };

export async function fetchInterimDocuments(args: { from?: string | null; list?: boolean; cursor?: string | null }, signal?: AbortSignal): Promise<InterimFetch> {
  try {
    const res = await fetch(`${INTERIM_DOCUMENTS_API}${interimQuery(args)}`, {
      headers: { authorization: `Bearer ${token()}` },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = (await res.json()) as InterimAnswer;
    if (!body || typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0) return { ok: false, status: 0 };
    return { ok: true, answer: body };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, status: 0 };
  }
}

/** A valid count for the confirmation body (the number the owner saw), or null. */
export function confirmableCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null;
}

// ── wording ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The owner-approved text (2026-11-24): "מאז [תאריך] הופקו [N] מסמכים כעוסק פטור. המסמכים יישארו ללא שינוי. מומלץ לבדוק
 * אותם עם רואה החשבון שלך." For N = 1 the same sentence in the singular; N = 0 is not shown as this note (nothing to
 * check) — see interimNone.
 */
export function interimSentence(count: number, fromDisplay: string): string {
  if (count === 1) return `מאז ${fromDisplay} הופק מסמך אחד כעוסק פטור. המסמך יישאר ללא שינוי. מומלץ לבדוק אותו עם רואה החשבון שלך.`;
  return `מאז ${fromDisplay} הופקו ${count} מסמכים כעוסק פטור. המסמכים יישארו ללא שינוי. מומלץ לבדוק אותם עם רואה החשבון שלך.`;
}

/** N = 0: nothing was issued in the window. */
export const interimNone = (fromDisplay: string) => `מאז ${fromDisplay} לא הופקו מסמכים כעוסק פטור.`;

export const INTERIM_LOAD_ERROR = "לא הצלחנו לבדוק אילו מסמכים הופקו מאז התאריך. אפשר לנסות שוב.";

/** 409 INTERIM_DOCUMENTS_CHANGED: a document was issued while the owner was confirming. Nothing was written. */
export function interimChangedMessage(count: number, fromDisplay: string): string {
  const now = count === 1 ? "הופק מסמך אחד" : count === 0 ? "לא הופקו מסמכים" : `הופקו ${count} מסמכים`;
  return `בזמן האישור השתנה מספר המסמכים: מאז ${fromDisplay} ${now} כעוסק פטור. המעבר לא בוצע ושום דבר לא השתנה. בדקו את המספר המעודכן ואשרו שוב.`;
}

export const DOCUMENT_TYPE_HE: Record<InterimItem["documentType"], string> = {
  TAX_INVOICE: "חשבונית מס",
  TAX_INVOICE_RECEIPT: "חשבונית מס-קבלה",
  RECEIPT: "קבלה",
  CREDIT_NOTE: "חשבונית זיכוי",
};

export function creditStateHe(s: InterimCreditState): string | null {
  return s === "FULL" ? "זוכתה במלואה" : s === "PARTIAL" ? "זוכתה בחלקה" : s === "LINKED" ? "יש זיכוי מקושר" : null;
}

/** Amount for display: "1,234.50 ₪" for ILS, otherwise the code after the number. */
export function displayAmount(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const s = new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return currency === "ILS" ? `${s} ₪` : `${s} ${currency}`;
}

/** Merge a further page into the list already shown (by id, keeping order). */
export function mergePages(shown: InterimItem[], page: InterimItem[]): InterimItem[] {
  const seen = new Set(shown.map((i) => i.id));
  return [...shown, ...page.filter((i) => !seen.has(i.id))];
}
