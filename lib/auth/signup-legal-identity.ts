/**
 * Signup — the business's LEGAL identity, decided before anything is written (owner decision 2026-11-12).
 *
 * Every new business enters it at signup, password or Google alike:
 *   עוסק פטור / עוסק מורשה — the owner's legal name and the dealer number;
 *   חברה בע״מ              — the company's legal name and its ח״פ;
 * plus, for all three: an optional trade name, the business address, a phone and an email.
 *
 * Dependency-free apart from the shared check-digit rule, like ./signup-identity.ts: the rules are provable in
 * milliseconds. The database repeats them (signup_legal_identity_seed, migration 20261128090000) as the backstop.
 *
 * What "valid" means here: the number has the published Israeli SHAPE (nine digits, eight when a leading zero
 * was dropped, and the check digit). That is a local format check and NOTHING MORE — the number is never
 * presented as confirmed against the Tax Authority or the Registrar of Companies.
 *
 * Privacy: an individual's dealer number is usually their national ID. Errors name the FIELD, never the value,
 * and nothing in this module logs.
 */

import { authoritativeTaxId } from "@/lib/identity/tax-id";

export const LEGAL_NAME_MIN = 2;
export const LEGAL_NAME_MAX = 120; // = the issuer declaration bound (#1117): a locked name it cannot carry would be stuck
export const TRADE_NAME_MAX = 120; // = MAX_BUSINESS_NAME_LENGTH: the trade name becomes Business.name
export const ADDRESS_MIN = 2;
export const ADDRESS_MAX = 300;
export const BUSINESS_EMAIL_MAX = 320;

const BUSINESS_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LegalIdentityKind = "EXEMPT_DEALER" | "AUTHORIZED_DEALER" | "LTD_COMPANY";

export type LegalIdentityField = "legalName" | "taxId" | "tradeName" | "address" | "phone" | "businessEmail";

export type LegalIdentityInput = {
  legalName?: unknown;
  taxId?: unknown;
  tradeName?: unknown;
  address?: unknown;
  phone?: unknown;
  businessEmail?: unknown;
};

/** Exactly what is persisted: the seed writes these values, nothing re-trims or re-formats them later. */
export type NormalizedLegalIdentity = {
  kind: LegalIdentityKind;
  legalName: string;
  /** Canonical nine digits. */
  taxId: string;
  /** null when the business has no separate trade name. */
  tradeName: string | null;
  address: string;
  /** Digits, with an optional leading "+". */
  phone: string;
  businessEmail: string;
};

export class LegalIdentityValidationError extends Error {
  readonly field: LegalIdentityField;
  constructor(field: LegalIdentityField, message: string) {
    super(message);
    this.name = "LegalIdentityValidationError";
    this.field = field;
  }
}

/** Labels per kind — the form and the errors use the same words. */
export function legalIdentityLabels(kind: LegalIdentityKind) {
  return kind === "LTD_COMPANY"
    ? { legalName: "שם החברה המשפטי", taxId: "מספר ח״פ", address: "כתובת החברה" }
    : { legalName: "שם משפטי של בעל העסק", taxId: "מספר עוסק", address: "כתובת העסק" };
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");

export function normalizePhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  return /^\+?\d{9,15}$/.test(compact) ? compact : null;
}

const FIELD_ORDER: readonly LegalIdentityField[] = ["legalName", "taxId", "tradeName", "address", "phone", "businessEmail"];

/**
 * Every field's error at once (the form shows them all under their fields), keyed by field, in form order.
 * Empty object = valid. Messages never contain the typed value.
 */
export function legalIdentityFieldErrors(
  kind: LegalIdentityKind,
  input: LegalIdentityInput
): Partial<Record<LegalIdentityField, string>> {
  const labels = legalIdentityLabels(kind);
  const { legalName, taxId, tradeName, address, phone, businessEmail } = input ?? {};
  const errors: Partial<Record<LegalIdentityField, string>> = {};

  if (typeof legalName !== "string" || collapse(legalName).length < LEGAL_NAME_MIN) {
    errors.legalName = `יש להזין ${labels.legalName}`;
  } else if (collapse(legalName).length > LEGAL_NAME_MAX) {
    errors.legalName = `${labels.legalName} ארוך מדי (עד ${LEGAL_NAME_MAX} תווים)`;
  }

  if (typeof taxId !== "string" || taxId.trim() === "") {
    errors.taxId = `יש להזין ${labels.taxId}`;
  } else if (authoritativeTaxId(taxId) === null) {
    errors.taxId = `${labels.taxId} אינו תקין. יש להזין 9 ספרות כפי שהן מופיעות במסמכים הרשמיים.`;
  }

  if (tradeName !== undefined && tradeName !== null) {
    if (typeof tradeName !== "string") errors.tradeName = "השם המסחרי אינו תקין";
    else if (collapse(tradeName).length > TRADE_NAME_MAX) errors.tradeName = `השם המסחרי ארוך מדי (עד ${TRADE_NAME_MAX} תווים)`;
    else if (collapse(tradeName).length === 1) errors.tradeName = "השם המסחרי קצר מדי";
  }

  if (typeof address !== "string" || collapse(address).length < ADDRESS_MIN) {
    errors.address = `יש להזין ${labels.address}`;
  } else if (collapse(address).length > ADDRESS_MAX) {
    errors.address = `הכתובת ארוכה מדי (עד ${ADDRESS_MAX} תווים)`;
  }

  if (typeof phone !== "string" || normalizePhone(phone) === null) {
    errors.phone = "יש להזין מספר טלפון תקין";
  }

  if (typeof businessEmail !== "string" || !BUSINESS_EMAIL_SHAPE.test(businessEmail.trim())
      || businessEmail.trim().length > BUSINESS_EMAIL_MAX) {
    errors.businessEmail = "יש להזין כתובת אימייל תקינה לעסק";
  }
  return errors;
}

/**
 * Validate and normalize, or throw naming the offending field. The order is the form's order, so the first
 * error is the one the owner sees first.
 */
export function normalizeLegalIdentity(kind: LegalIdentityKind, input: LegalIdentityInput): NormalizedLegalIdentity {
  const errors = legalIdentityFieldErrors(kind, input);
  const first = FIELD_ORDER.find((f) => errors[f] !== undefined);
  if (first) throw new LegalIdentityValidationError(first, errors[first] as string);

  const v = input as Required<Record<keyof LegalIdentityInput, string>> & { tradeName?: string | null };
  const trade = typeof v.tradeName === "string" ? collapse(v.tradeName) : "";
  return {
    kind,
    legalName: collapse(v.legalName),
    taxId: authoritativeTaxId(v.taxId) as string,
    tradeName: trade.length === 0 ? null : trade,
    address: collapse(v.address),
    phone: normalizePhone(v.phone) as string,
    businessEmail: v.businessEmail.trim().toLowerCase(),
  };
}

/** The name the app shows (Business.name): the trade name when there is one, otherwise the legal name. */
export function displayNameFor(identity: Pick<NormalizedLegalIdentity, "legalName" | "tradeName">): string {
  return (identity.tradeName ?? identity.legalName).slice(0, TRADE_NAME_MAX);
}
