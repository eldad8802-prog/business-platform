/**
 * Issuer details completion (#1081) — what a business must have on file, by its kind, before it may confirm the
 * issuer declaration and before its first issuance. Pure: no database, no clock.
 *
 * Signup collects the business kind only (owner decision 2026-11-11). Everything else is completed here, from the
 * billing identity on BusinessProfile, and checked in the shape the declaration table accepts
 * (prisma/migrations/20261126100000_issuer_declaration: track shape, 9-digit numbers, length bounds) so a complete
 * profile always yields an insertable declaration.
 *
 * Law vs product:
 *   - the 9-digit identity / company number and its check digit are the published Israeli number format;
 *   - an authorized dealer (individual or company) carries a VAT registration number (חוק מע"מ, s.52 ff.);
 *   - an exempt dealer charges no VAT, so the declaration carries no VAT registration number — and the profile
 *     must not carry one either, because once declared the profile identity is locked to the declaration
 *     (product rule, follows the migration's identity lock);
 *   - the phone and e-mail checks are product plausibility checks, not law.
 */

import { parseBillingBusinessKind, type BillingBusinessKind } from "@/lib/billing/business-identity";

export type IssuerTrack = "EXEMPT_DEALER" | "AUTHORIZED_DEALER_INDIVIDUAL" | "COMPANY_AUTHORIZED_DEALER";
export type IssuerLegalForm = "INDIVIDUAL" | "COMPANY";
export type IssuerVatStatus = "EXEMPT" | "AUTHORIZED";
export type IssuerIdType = "ISRAELI_ID" | "COMPANY_NUMBER";

export type IssuerTrackShape = {
  track: IssuerTrack;
  legalForm: IssuerLegalForm;
  vatStatus: IssuerVatStatus;
  idType: IssuerIdType;
};

/** The declaration's track for each signup kind — the same mapping the profile identity lock uses. */
export const TRACK_BY_KIND: Record<BillingBusinessKind, IssuerTrackShape> = {
  EXEMPT_DEALER: { track: "EXEMPT_DEALER", legalForm: "INDIVIDUAL", vatStatus: "EXEMPT", idType: "ISRAELI_ID" },
  AUTHORIZED_DEALER: { track: "AUTHORIZED_DEALER_INDIVIDUAL", legalForm: "INDIVIDUAL", vatStatus: "AUTHORIZED", idType: "ISRAELI_ID" },
  LTD_COMPANY: { track: "COMPANY_AUTHORIZED_DEALER", legalForm: "COMPANY", vatStatus: "AUTHORIZED", idType: "COMPANY_NUMBER" },
};

export type IssuerDetailsInput = {
  billingBusinessKind: string | null;
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  billingAddress: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
};

export type IssuerDetailField = keyof IssuerDetailsInput;
export type IssuerDetailProblemCode = "MISSING" | "FORMAT" | "CHECK_DIGIT" | "TOO_LONG" | "NOT_APPLICABLE";
export type IssuerDetailProblem = { field: IssuerDetailField; code: IssuerDetailProblemCode; message: string };

/** The fields each kind must complete (the kind itself comes from signup). */
export const REQUIRED_FIELDS_BY_KIND: Record<BillingBusinessKind, readonly IssuerDetailField[]> = {
  EXEMPT_DEALER: ["billingLegalName", "billingTaxId", "billingAddress", "billingPhone", "billingEmail"],
  AUTHORIZED_DEALER: ["billingLegalName", "billingTaxId", "billingVatNumber", "billingAddress", "billingPhone", "billingEmail"],
  LTD_COMPANY: ["billingLegalName", "billingTaxId", "billingVatNumber", "billingAddress", "billingPhone", "billingEmail"],
};

/** Matches the e-mail template's bound; the declaration table allows 200. */
export const MAX_LEGAL_NAME = 120;
const MAX_ADDRESS = 300;
const MAX_PHONE = 30;
const MAX_EMAIL = 320;

const FIELD_LABEL: Record<IssuerDetailField, string> = {
  billingBusinessKind: "סוג העסק",
  billingLegalName: "השם הרשמי",
  billingTaxId: "מספר הזהות או מספר החברה",
  billingVatNumber: "מספר עוסק מורשה",
  billingAddress: "הכתובת",
  billingPhone: "הטלפון",
  billingEmail: "האימייל",
};

/** The Israeli 9-digit number check (identity numbers and company numbers alike). Exactly 9 digits, no separators. */
export function hasValidIsraeliCheckDigit(value: string): boolean {
  if (!/^[0-9]{9}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(value[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

function text(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function numberProblem(field: IssuerDetailField, value: string): IssuerDetailProblem | null {
  if (!/^[0-9]{9}$/.test(value)) {
    return { field, code: "FORMAT", message: `${FIELD_LABEL[field]} צריך להיות 9 ספרות, בלי רווחים או מקפים.` };
  }
  if (!hasValidIsraeliCheckDigit(value)) {
    return { field, code: "CHECK_DIGIT", message: `${FIELD_LABEL[field]} אינו תקין (ספרת הביקורת אינה מתאימה).` };
  }
  return null;
}

/**
 * Every problem that keeps these details from a declaration, in field order. Empty means complete. Values are
 * checked as stored (trimmed for text, exact for numbers) — the declaration is built from exactly these values.
 */
export function validateIssuerDetails(p: Partial<IssuerDetailsInput> | null | undefined): IssuerDetailProblem[] {
  const kind = parseBillingBusinessKind(p?.billingBusinessKind ?? null);
  if (!kind) {
    return [{ field: "billingBusinessKind", code: "MISSING", message: "יש לבחור סוג עסק: עוסק פטור, עוסק מורשה או חברה בע״מ." }];
  }
  const problems: IssuerDetailProblem[] = [];
  const required = REQUIRED_FIELDS_BY_KIND[kind];
  for (const field of required) {
    if (!text(p?.[field])) problems.push({ field, code: "MISSING", message: `יש למלא את ${FIELD_LABEL[field]}.` });
  }
  const filled = (f: IssuerDetailField) => required.includes(f) && text(p?.[f]) !== "";

  if (filled("billingLegalName") && text(p?.billingLegalName).length > MAX_LEGAL_NAME) {
    problems.push({ field: "billingLegalName", code: "TOO_LONG", message: `השם הרשמי ארוך מ־${MAX_LEGAL_NAME} תווים.` });
  }
  if (filled("billingTaxId")) {
    const pr = numberProblem("billingTaxId", p?.billingTaxId ?? "");
    if (pr) problems.push(pr);
  }
  if (filled("billingVatNumber")) {
    const pr = numberProblem("billingVatNumber", p?.billingVatNumber ?? "");
    if (pr) problems.push(pr);
  }
  if (kind === "EXEMPT_DEALER" && text(p?.billingVatNumber)) {
    problems.push({ field: "billingVatNumber", code: "NOT_APPLICABLE", message: "לעוסק פטור אין מספר עוסק מורשה. יש להשאיר את השדה ריק." });
  }
  if (filled("billingAddress") && text(p?.billingAddress).length > MAX_ADDRESS) {
    problems.push({ field: "billingAddress", code: "TOO_LONG", message: `הכתובת ארוכה מ־${MAX_ADDRESS} תווים.` });
  }
  if (filled("billingPhone")) {
    const phone = text(p?.billingPhone);
    const digits = phone.replace(/\D/g, "").length;
    if (phone.length > MAX_PHONE || !/^[0-9+\-() ]+$/.test(phone) || digits < 9 || digits > 15) {
      problems.push({ field: "billingPhone", code: "FORMAT", message: "מספר הטלפון אינו תקין." });
    }
  }
  if (filled("billingEmail")) {
    const email = text(p?.billingEmail);
    if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push({ field: "billingEmail", code: "FORMAT", message: "כתובת האימייל אינה תקינה." });
    }
  }
  return problems;
}

/** The declared identity fields — what the profile identity lock compares against the declaration. */
export const ISSUER_IDENTITY_FIELDS = ["billingBusinessKind", "billingTaxId", "billingVatNumber", "billingLegalName"] as const;
