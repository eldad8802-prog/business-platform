/**
 * Receipt screen model (pure: no DB, no network, no clock). The screen issues a RECEIPT through the EXISTING billing
 * routes only (create draft → payment lines → allocations → issue); every rule here mirrors a rule the billing service
 * already enforces, so the owner sees the problem before the request — the server stays the authority and is not
 * changed. Amounts are kept as whole agorot to avoid float drift and are sent as decimal strings, as billing expects.
 *
 *   - Payment methods and their required fields: lib/services/billing/validation/billing-payment.validation.ts
 *     (DIRECT_DEBIT / STANDING_ORDER are refused on a billing document, so they are not offered).
 *   - Allocations: only to an ISSUED TAX_INVOICE of the same customer, positive, within the invoice's remaining, each
 *     invoice once; with any allocation, Σ allocations must equal the receipt total
 *     (lib/services/billing/receipt/billing-receipt-allocation.rules.ts). No allocation = a receipt owed against nothing.
 */

export type ReceiptMethod = "CASH" | "BANK_TRANSFER" | "CHECK" | "CREDIT_CARD" | "BIT" | "PAYBOX" | "OTHER";

export const METHOD_LABEL: Record<ReceiptMethod, string> = {
  CASH: "מזומן",
  BANK_TRANSFER: "העברה בנקאית",
  CHECK: "צ׳ק",
  CREDIT_CARD: "כרטיס אשראי",
  BIT: "ביט",
  PAYBOX: "פייבוקס",
  OTHER: "אחר",
};

export const METHODS = Object.keys(METHOD_LABEL) as ReceiptMethod[];

export type PaymentLineForm = {
  method: ReceiptMethod;
  amount: string;
  paymentDate: string;
  bankName: string;
  bankBranch: string;
  bankAccountNumber: string;
  checkNumber: string;
  checkDueDate: string;
  cardBrand: string;
  cardLast4: string;
  reference: string;
};

export type LineField = Exclude<keyof PaymentLineForm, "method">;

export const FIELD_LABEL: Record<LineField, string> = {
  amount: "סכום",
  paymentDate: "תאריך התשלום",
  bankName: "בנק",
  bankBranch: "סניף",
  bankAccountNumber: "מספר חשבון",
  checkNumber: "מספר צ׳ק",
  checkDueDate: "תאריך פירעון",
  cardBrand: "סוג כרטיס",
  cardLast4: "4 ספרות אחרונות",
  reference: "אסמכתא",
};

/** The fields each method needs, besides amount and date (same list as the billing validation). */
export const METHOD_FIELDS: Record<ReceiptMethod, LineField[]> = {
  CASH: [],
  BANK_TRANSFER: ["bankName", "bankBranch", "bankAccountNumber"],
  CHECK: ["bankName", "bankBranch", "bankAccountNumber", "checkNumber", "checkDueDate"],
  CREDIT_CARD: ["cardBrand", "cardLast4"],
  BIT: ["reference"],
  PAYBOX: ["reference"],
  OTHER: ["reference"],
};

export function emptyLine(today: string): PaymentLineForm {
  return { method: "CASH", amount: "", paymentDate: today, bankName: "", bankBranch: "", bankAccountNumber: "", checkNumber: "", checkDueDate: "", cardBrand: "", cardLast4: "", reference: "" };
}

/** "1,234.5" / "1234.50" → 123450 agorot; null when it is not a positive amount with at most two decimals. */
export function toAgorot(value: string): number | null {
  const t = value.replace(/[,\s₪]/g, "");
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const n = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return n > 0 ? n : null;
}

/** 123450 → "1234.50" (what the billing routes parse). */
export function agorotToDecimal(n: number): string {
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** 123450 → "1,234.50" for the screen. */
export function formatAgorot(n: number): string {
  return `${Math.floor(n / 100).toLocaleString("en-US")}.${String(n % 100).padStart(2, "0")}`;
}

/** A billing decimal ("4096.13", 4096.13) → agorot, rounding only representation noise. */
export function decimalToAgorot(value: string | number): number {
  return Math.round(Number(value) * 100);
}

export type OpenInvoice = { id: number; number: string | null; issuedAt: string | null; totalAgorot: number; remainingAgorot: number };

export type ReceiptForm = {
  customerId: string;
  lines: PaymentLineForm[];
  /** invoice id → amount typed for it ("" = not allocated). */
  allocations: Record<number, string>;
};

export type Problems = Record<string, string>;

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export function linesTotal(lines: PaymentLineForm[]): number {
  return lines.reduce((sum, l) => sum + (toAgorot(l.amount) ?? 0), 0);
}

export function allocationsTotal(allocations: Record<number, string>): number {
  return Object.values(allocations).reduce((sum, v) => sum + (v.trim() === "" ? 0 : toAgorot(v) ?? 0), 0);
}

/** Every problem the billing service would refuse, keyed for the screen. Empty = ready to issue. */
export function receiptProblems(form: ReceiptForm, invoices: OpenInvoice[]): Problems {
  const p: Problems = {};
  if (!/^\d+$/.test(form.customerId)) p.customer = "יש לבחור לקוח";
  if (form.lines.length === 0) p.lines = "יש להוסיף לפחות תשלום אחד";
  form.lines.forEach((line, i) => {
    if (toAgorot(line.amount) === null) p[`line.${i}.amount`] = "סכום חיובי, עד שתי ספרות אחרי הנקודה";
    if (!isDay(line.paymentDate)) p[`line.${i}.paymentDate`] = "יש לבחור תאריך";
    for (const f of METHOD_FIELDS[line.method]) {
      const v = line[f].trim();
      if (f === "checkDueDate") {
        if (!isDay(v)) p[`line.${i}.${f}`] = "יש לבחור תאריך";
      } else if (f === "cardLast4") {
        if (!/^\d{4}$/.test(v)) p[`line.${i}.${f}`] = "בדיוק 4 ספרות";
      } else if (v === "") {
        p[`line.${i}.${f}`] = `חסר ${FIELD_LABEL[f]}`;
      } else if (v.length > 200) {
        p[`line.${i}.${f}`] = "עד 200 תווים";
      }
    }
    if (line.reference.trim().length > 200) p[`line.${i}.reference`] = "עד 200 תווים";
  });
  const byId = new Map(invoices.map((inv) => [inv.id, inv]));
  let anyAllocation = false;
  for (const [key, raw] of Object.entries(form.allocations)) {
    if (raw.trim() === "") continue;
    anyAllocation = true;
    const inv = byId.get(Number(key));
    const amount = toAgorot(raw);
    if (!inv) p[`alloc.${key}`] = "החשבונית כבר לא פתוחה";
    else if (amount === null) p[`alloc.${key}`] = "סכום חיובי, עד שתי ספרות אחרי הנקודה";
    else if (amount > inv.remainingAgorot) p[`alloc.${key}`] = `יותר מהיתרה הפתוחה (${formatAgorot(inv.remainingAgorot)})`;
  }
  if (anyAllocation && allocationsTotal(form.allocations) !== linesTotal(form.lines)) {
    p.allocTotal = `סכום השיוך לחשבוניות (${formatAgorot(allocationsTotal(form.allocations))}) חייב להיות שווה לסכום הקבלה (${formatAgorot(linesTotal(form.lines))})`;
  }
  return p;
}

/** The body of POST /api/billing/documents/[id]/payments — only the fields the method uses. */
export function paymentsPayload(lines: PaymentLineForm[]): { payments: Record<string, string | number>[] } {
  return {
    payments: lines.map((line, i) => {
      const out: Record<string, string | number> = { lineIndex: i + 1, method: line.method, amount: agorotToDecimal(toAgorot(line.amount) ?? 0), currency: "ILS", paymentDate: line.paymentDate };
      for (const f of METHOD_FIELDS[line.method]) out[f] = line[f].trim();
      if (line.reference.trim() !== "") out.reference = line.reference.trim();
      return out;
    }),
  };
}

/** The body of POST /api/billing/documents/[id]/allocations, or null when the receipt is not allocated. */
export function allocationsPayload(allocations: Record<number, string>): { allocations: { invoiceDocumentId: number; allocatedAmount: string }[] } | null {
  const list = Object.entries(allocations)
    .filter(([, v]) => v.trim() !== "")
    .map(([id, v]) => ({ invoiceDocumentId: Number(id), allocatedAmount: agorotToDecimal(toAgorot(v) ?? 0) }));
  return list.length === 0 ? null : { allocations: list };
}

/** Fill the allocation of each open invoice, oldest first, up to the receipt total (the owner can still edit it). */
export function autoAllocate(total: number, invoices: OpenInvoice[]): Record<number, string> {
  let left = total;
  const out: Record<number, string> = {};
  const oldestFirst = [...invoices].sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? "") || a.id - b.id);
  for (const inv of oldestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, inv.remainingAgorot);
    out[inv.id] = agorotToDecimal(take);
    left -= take;
  }
  return out;
}

/** "קבלה מרכזת": one receipt that settles more than one invoice. */
export function isConsolidated(allocations: Record<number, string>): boolean {
  return Object.values(allocations).filter((v) => v.trim() !== "").length > 1;
}

const SERVER_TEXT: [RegExp, string][] = [
  [/Sum of allocations must equal the receipt total|allocations must account/i, "סכום השיוך לחשבוניות חייב להיות שווה לסכום הקבלה."],
  [/exceeds|remaining|over-?allocat/i, "אחד הסכומים גבוה מהיתרה הפתוחה של החשבונית. רעננו את הרשימה ונסו שוב."],
  [/ISSUED invoice|TAX_INVOICE/i, "אפשר לשייך רק לחשבונית מס שהופקה."],
  [/required for this payment method|cardLast4|must be exactly 4 digits/i, "חסר פרט בתשלום. בדקו את שדות התשלום."],
  [/customer/i, "יש לבחור לקוח."],
  [/already issued|not a draft|Only DRAFT/i, "הקבלה כבר הופקה."],
  [/business (details|identity)|פרטי העסק/i, "יש להשלים את פרטי העסק במסך ההגדרות לפני הפקה."],
];

/** A billing route's refusal (English, from the existing service) → a Hebrew sentence for the owner. */
export function billingErrorText(status: number | null, message: string): string {
  if (status === null) return "אין חיבור. נסו שוב.";
  if (status === 401) return "צריך להתחבר מחדש.";
  for (const [re, text] of SERVER_TEXT) if (re.test(message)) return text;
  return "הפעולה נכשלה. נסו שוב.";
}
