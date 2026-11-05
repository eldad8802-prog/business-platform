/**
 * ר2 — a business letter. Pure contracts: validation of what the owner typed.
 *
 * A letter has NO accounting meaning: no legal number, no amount, no effect on
 * payments, stock or the uniform export. It is rendered on demand from these
 * fields and the business's own details; nothing is stored by this module.
 */

export const LETTER_LIMITS = {
  subject: 200,
  body: 10_000,
  recipientName: 200,
  recipientAddress: 500,
  signerName: 120,
  signerTitle: 120,
  reference: 60,
} as const;

export type LetterRecipientKind = "customer" | "supplier" | "free";

/** What the browser sends. Every field is untrusted. */
export type LetterInputRaw = {
  recipientKind?: unknown;
  customerId?: unknown;
  supplierId?: unknown;
  recipientName?: unknown;
  recipientAddress?: unknown;
  subject?: unknown;
  body?: unknown;
  date?: unknown;
  reference?: unknown;
  signerName?: unknown;
  signerTitle?: unknown;
  includeSignatureImage?: unknown;
};

export type LetterInput = {
  recipientKind: LetterRecipientKind;
  customerId: number | null;
  supplierId: number | null;
  /** Free text; for a customer / supplier the server fills it from the record when left empty. */
  recipientName: string;
  recipientAddress: string;
  subject: string;
  body: string;
  /** YYYY-MM-DD, the date printed on the letter. */
  date: string;
  /** Optional free reference the owner wants printed ("סימוכין"); not a legal number. */
  reference: string;
  signerName: string;
  signerTitle: string;
  includeSignatureImage: boolean;
};

export type LetterProblem = { field: keyof LetterInput; message: string };

export class LetterValidationError extends Error {
  constructor(public readonly problems: LetterProblem[]) {
    super(problems.map((p) => `${p.field}: ${p.message}`).join("; "));
    this.name = "LetterValidationError";
  }
}

// Control characters other than tab / newline are never accepted (they break PDF text and hide content).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function text(value: unknown, max: number, field: keyof LetterInput, problems: LetterProblem[], opts: { required?: boolean; multiline?: boolean } = {}): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") {
    problems.push({ field, message: "ערך לא תקין" });
    return "";
  }
  const v = opts.multiline ? value.replace(/\r\n?/g, "\n").trim() : value.replace(/\s+/g, " ").trim();
  if (CONTROL.test(v)) problems.push({ field, message: "יש תווים שאי אפשר להדפיס" });
  if (opts.required && v.length === 0) problems.push({ field, message: "שדה חובה" });
  if ([...v].length > max) problems.push({ field, message: `עד ${max.toLocaleString("he-IL")} תווים` });
  return v;
}

function positiveId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

export function parseLetterInput(raw: LetterInputRaw): LetterInput {
  const problems: LetterProblem[] = [];
  const kind = raw.recipientKind ?? "free";
  const recipientKind: LetterRecipientKind = kind === "customer" || kind === "supplier" || kind === "free" ? kind : "free";
  if (kind !== recipientKind) problems.push({ field: "recipientKind", message: "סוג נמען לא תקין" });

  const customerId = positiveId(raw.customerId);
  const supplierId = positiveId(raw.supplierId);
  if (Number.isNaN(customerId)) problems.push({ field: "customerId", message: "לקוח לא תקין" });
  if (Number.isNaN(supplierId)) problems.push({ field: "supplierId", message: "ספק לא תקין" });
  if (recipientKind === "customer" && !customerId) problems.push({ field: "customerId", message: "יש לבחור לקוח" });
  if (recipientKind === "supplier" && !supplierId) problems.push({ field: "supplierId", message: "יש לבחור ספק" });

  const recipientName = text(raw.recipientName, LETTER_LIMITS.recipientName, "recipientName", problems, { required: recipientKind === "free" });
  const recipientAddress = text(raw.recipientAddress, LETTER_LIMITS.recipientAddress, "recipientAddress", problems, { multiline: true });
  const subject = text(raw.subject, LETTER_LIMITS.subject, "subject", problems, { required: true });
  const body = text(raw.body, LETTER_LIMITS.body, "body", problems, { required: true, multiline: true });
  const reference = text(raw.reference, LETTER_LIMITS.reference, "reference", problems);
  const signerName = text(raw.signerName, LETTER_LIMITS.signerName, "signerName", problems);
  const signerTitle = text(raw.signerTitle, LETTER_LIMITS.signerTitle, "signerTitle", problems);

  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (!isRealDate(date)) problems.push({ field: "date", message: "תאריך לא תקין" });

  if (raw.includeSignatureImage !== undefined && typeof raw.includeSignatureImage !== "boolean") {
    problems.push({ field: "includeSignatureImage", message: "ערך לא תקין" });
  }

  if (problems.length) throw new LetterValidationError(problems);
  return {
    recipientKind,
    customerId: recipientKind === "customer" ? (customerId as number) : null,
    supplierId: recipientKind === "supplier" ? (supplierId as number) : null,
    recipientName,
    recipientAddress,
    subject,
    body,
    date,
    reference,
    signerName,
    signerTitle,
    includeSignatureImage: raw.includeSignatureImage === true,
  };
}

/** dd.mm.yyyy for a YYYY-MM-DD date (no clock, no time zone involved). */
export function formatLetterDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

/** The PDF file name: never derived from free text beyond a safe slug. */
export function letterFileName(input: Pick<LetterInput, "date">): string {
  return `letter-${input.date}.pdf`;
}
