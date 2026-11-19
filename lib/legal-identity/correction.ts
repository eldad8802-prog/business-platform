/**
 * Legal identity correction (owner decision 2026-11-13) — the rules a correction REQUEST must satisfy before it is
 * sent, the same ones the database repeats (legal_identity_correction_request, migration 20261128100000).
 *
 * A confirmed identity (business kind, legal name, dealer number / ח"פ) is never edited directly. The business asks;
 * an authorized party that is not the requester decides; an approved request is applied atomically and stays on
 * record. Two kinds of request, told apart by what changes:
 *   TYPO_CORRECTION       the same legal entity, a value typed wrong at signup: the business kind stays the same.
 *   BUSINESS_KIND_CHANGE  the same person or company changes status (e.g. עוסק פטור → עוסק מורשה): the number stays.
 * Moving between an individual (עוסק פטור / מורשה) and a company (חברה בע״מ) is a DIFFERENT legal entity — never a
 * correction: that is a new business. Changing the number of a different entity is likewise refused: the requester
 * must declare the request concerns the same legal entity, and the approver verifies it.
 *
 * Pure: no database, no clock. Errors name the field, never the value.
 */

import { authoritativeTaxId } from "@/lib/identity/tax-id";

export const CORRECTION_KINDS = ["TYPO_CORRECTION", "BUSINESS_KIND_CHANGE"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export const BUSINESS_KINDS = ["EXEMPT_DEALER", "AUTHORIZED_DEALER", "LTD_COMPANY"] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

export const REASON_MIN = 10;
export const REASON_MAX = 1000;
export const LEGAL_NAME_MIN = 2;
export const LEGAL_NAME_MAX = 120; // the issuer declaration's bound, as at signup

export type CurrentIdentity = { businessKind: string; legalName: string; taxId: string };
export type CorrectionInput = {
  requestedBusinessKind?: unknown;
  requestedLegalName?: unknown;
  requestedTaxId?: unknown;
  reason?: unknown;
  sameLegalEntity?: unknown;
};
export type CorrectionField =
  | "requestedBusinessKind"
  | "requestedLegalName"
  | "requestedTaxId"
  | "reason"
  | "sameLegalEntity"
  | "noChange";

export type NormalizedCorrection = {
  kind: CorrectionKind;
  requestedBusinessKind: BusinessKind;
  requestedLegalName: string;
  requestedTaxId: string;
  reason: string;
};

export class CorrectionValidationError extends Error {
  readonly field: CorrectionField;
  constructor(field: CorrectionField, message: string) {
    super(message);
    this.name = "CorrectionValidationError";
    this.field = field;
  }
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
const isKind = (k: unknown): k is BusinessKind => typeof k === "string" && (BUSINESS_KINDS as readonly string[]).includes(k);
const isCompany = (k: string) => k === "LTD_COMPANY";

/**
 * Validate a request against the current confirmed identity. Throws the first problem in form order; returns the
 * exact values to send (the kind of request is derived, never chosen by the client).
 */
export function normalizeCorrection(current: CurrentIdentity, input: CorrectionInput): NormalizedCorrection {
  const { requestedBusinessKind, requestedLegalName, requestedTaxId, reason, sameLegalEntity } = input ?? {};

  if (!isKind(requestedBusinessKind)) {
    throw new CorrectionValidationError("requestedBusinessKind", "יש לבחור את סוג העסק המבוקש");
  }
  if (isCompany(requestedBusinessKind) !== isCompany(current.businessKind)) {
    throw new CorrectionValidationError(
      "requestedBusinessKind",
      "מעבר בין עוסק לבין חברה בע״מ הוא ישות משפטית אחרת ואינו תיקון. במקרה כזה יש לפתוח עסק חדש."
    );
  }
  if (typeof requestedLegalName !== "string" || collapse(requestedLegalName).length < LEGAL_NAME_MIN) {
    throw new CorrectionValidationError("requestedLegalName", "יש להזין את השם המשפטי המבוקש");
  }
  if (collapse(requestedLegalName).length > LEGAL_NAME_MAX) {
    throw new CorrectionValidationError("requestedLegalName", `השם המשפטי ארוך מדי (עד ${LEGAL_NAME_MAX} תווים)`);
  }
  const taxId = typeof requestedTaxId === "string" ? authoritativeTaxId(requestedTaxId) : null;
  if (taxId === null) {
    throw new CorrectionValidationError("requestedTaxId", "המספר המבוקש אינו תקין. יש להזין 9 ספרות כפי שהן מופיעות במסמכים הרשמיים.");
  }
  if (typeof reason !== "string" || collapse(reason).length < REASON_MIN) {
    throw new CorrectionValidationError("reason", `יש לפרט את סיבת הבקשה (לפחות ${REASON_MIN} תווים)`);
  }
  if (reason.trim().length > REASON_MAX) {
    throw new CorrectionValidationError("reason", `הסיבה ארוכה מדי (עד ${REASON_MAX} תווים)`);
  }
  if (sameLegalEntity !== true) {
    throw new CorrectionValidationError(
      "sameLegalEntity",
      "יש לאשר שהבקשה נוגעת לאותה ישות משפטית. שינוי לישות אחרת אינו מתבצע בתיקון פרטים."
    );
  }

  const legalName = collapse(requestedLegalName);
  if (requestedBusinessKind === current.businessKind && legalName === current.legalName && taxId === current.taxId) {
    throw new CorrectionValidationError("noChange", "הפרטים המבוקשים זהים לפרטים הקיימים");
  }
  let kind: CorrectionKind;
  if (requestedBusinessKind === current.businessKind) {
    kind = "TYPO_CORRECTION";
  } else {
    if (taxId !== current.taxId) {
      throw new CorrectionValidationError(
        "requestedTaxId",
        "בשינוי סוג העסק מספר העוסק נשאר זהה. תיקון המספר מוגש בבקשה נפרדת."
      );
    }
    kind = "BUSINESS_KIND_CHANGE";
  }
  return { kind, requestedBusinessKind, requestedLegalName: legalName, requestedTaxId: taxId, reason: reason.trim() };
}

/** Database refusal codes (DZC01..DZC07) → a stable application code. Never carries a value. */
export function correctionCodeFromDbError(error: unknown): string | null {
  const text = error instanceof Error ? error.message : "";
  if (/DZC06|ALREADY_OPEN|LegalIdentityCorrection_one_open_per_business/.test(text)) return "CORRECTION_ALREADY_OPEN";
  if (/DZC02|VERIFICATION_STALE/.test(text)) return "VERIFICATION_STALE";
  if (/DZC03|DIFFERENT_ENTITY/.test(text)) return "DIFFERENT_LEGAL_ENTITY";
  if (/DZC05|KIND_RULE/.test(text)) return "CORRECTION_KIND_RULE";
  if (/DZC04|CORRECTION_INVALID/.test(text)) return "CORRECTION_INVALID";
  if (/LEGAL_IDENTITY_NOT_CONFIRMED/.test(text)) return "IDENTITY_NOT_CONFIRMED";
  if (/DZC01|NOT_ALLOWED/.test(text)) return "NOT_ALLOWED";
  return null;
}
