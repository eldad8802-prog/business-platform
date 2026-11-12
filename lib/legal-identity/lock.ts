/**
 * The legal-identity lock, as the application applies it (owner decision 2026-11-12; migration
 * 20261128090000_signup_legal_identity is the backstop: BusinessProfile_legal_identity_lock refuses the same
 * change in the database, whoever writes it).
 *
 * Once a business's identity is confirmed (BusinessProfile.legalIdentityConfirmedAt — at signup, or by the
 * controlled completion for an existing business), its business kind, legal name and tax id cannot be changed by
 * the business on its own. Everything else on the profile stays editable. A legal change is a separate,
 * controlled correction (authorization, reason, audit) that is NOT built yet and needs its own approval.
 *
 * Pure: the caller reads the profile in its tenant transaction and hands the values in.
 */

import { ConflictError } from "@/lib/errors";
import { authoritativeTaxId } from "@/lib/identity/tax-id";

export const LOCKED_LEGAL_IDENTITY_FIELDS = ["billingBusinessKind", "billingLegalName", "billingTaxId"] as const;
export type LockedLegalIdentityField = (typeof LOCKED_LEGAL_IDENTITY_FIELDS)[number];

export const LEGAL_IDENTITY_LOCKED_CODE = "LEGAL_IDENTITY_LOCKED";
export const LEGAL_IDENTITY_LOCKED_MESSAGE =
  "סוג העסק, השם המשפטי ומספר העוסק / ח״פ ננעלו לאחר אישור פרטי העסק ואי אפשר לשנות אותם כאן. לתיקון פרטים חוקיים יש לפנות לתמיכה.";

/** Thrown when a request would change a locked field. Names the fields, never their values. */
export class LegalIdentityLockedError extends ConflictError {
  readonly fields: LockedLegalIdentityField[];
  constructor(fields: LockedLegalIdentityField[]) {
    super(LEGAL_IDENTITY_LOCKED_CODE, LEGAL_IDENTITY_LOCKED_MESSAGE);
    this.name = "LegalIdentityLockedError";
    this.fields = fields;
  }
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().replace(/\s+/g, " ") === (b ?? "").trim().replace(/\s+/g, " ");

function sameValue(field: LockedLegalIdentityField, before: string | null | undefined, next: string | null | undefined) {
  if (field === "billingTaxId") {
    // "51-412345-6" and "514123456" are the same number.
    const a = authoritativeTaxId(before) ?? (before ?? "").trim();
    const b = authoritativeTaxId(next) ?? (next ?? "").trim();
    return a === b;
  }
  return sameText(before, next);
}

/**
 * The write the request may make. Unconfirmed identity: the payload as is. Confirmed identity: a locked field
 * re-sent with the SAME value (forms send every field back) is dropped from the write; one with a DIFFERENT value
 * refuses the whole request with LegalIdentityLockedError — nothing is written.
 */
export function applyLegalIdentityLock<P extends Partial<Record<string, string | null>>>(
  confirmedAt: Date | null | undefined,
  before: Partial<Record<LockedLegalIdentityField, string | null>> | null,
  persist: P
): P {
  if (!confirmedAt) return persist;
  const changed: LockedLegalIdentityField[] = [];
  const out: Record<string, string | null | undefined> = { ...persist };
  for (const field of LOCKED_LEGAL_IDENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(persist, field)) continue;
    if (sameValue(field, before?.[field], persist[field])) delete out[field];
    else changed.push(field);
  }
  if (changed.length > 0) throw new LegalIdentityLockedError(changed);
  return out as P;
}

/** The database backstop's refusal (DZL04 / DZL03), surfaced as the same 409 when the app check was raced. */
export function isLegalIdentityLockDbError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : "";
  return /DZL0[34]|LEGAL_IDENTITY_LOCKED|LEGAL_IDENTITY_STATE_IS_SERVER_OWNED/.test(text);
}
