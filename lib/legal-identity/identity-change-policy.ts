/**
 * Legal identity change policy (owner decision 2026-11-20): a business file's legal identity is never changed after
 * the fact. There are exactly two ways forward, and no request / approver mechanism:
 *
 *   Path A — "מעבר לעוסק מורשה": the SAME legal entity (same person, same id number, same legal name) moves from
 *            עוסק פטור to עוסק מורשה inside the same business file, through a controlled flow the owner confirms
 *            explicitly (lib/legal-identity/kind-transition.ts).
 *   Path B — any change of legal name or id number, even a single typo, and any move to a different legal form
 *            (individual ↔ company): a NEW business file. The old file and every document it issued stay as they are.
 *
 * This module only CLASSIFIES a requested change; it never writes. Pure: no database, no network.
 */

import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { BILLING_BUSINESS_KIND_LABELS, parseBillingBusinessKind, type BillingBusinessKind } from "@/lib/billing/business-identity";

export type LegalIdentitySlice = {
  billingBusinessKind: string | null;
  billingLegalName: string | null;
  billingTaxId: string | null;
};

export type IdentityChangeVerdict =
  /** Nothing in the legal identity changes (formatting only, or the same values re-sent). */
  | { path: "NO_LEGAL_CHANGE" }
  /** Path A: exempt → authorized dealer, same entity. Only through the controlled transition flow. */
  | { path: "KIND_TRANSITION"; from: "EXEMPT_DEALER"; to: "AUTHORIZED_DEALER"; message: string }
  /** Path B: a different legal identity. Open a new business file; the current one is never changed. */
  | { path: "NEW_BUSINESS_FILE"; reasons: NewBusinessFileReason[]; message: string }
  /** A change with no defined path yet (owner decision pending). Refused. */
  | { path: "NOT_SUPPORTED"; reason: "AUTHORIZED_TO_EXEMPT" | "UNKNOWN_KIND"; message: string };

export type NewBusinessFileReason = "LEGAL_NAME_CHANGED" | "TAX_ID_CHANGED" | "LEGAL_FORM_CHANGED";

export const KIND_TRANSITION_MESSAGE =
  "מעבר מעוסק פטור לעוסק מורשה נעשה בתהליך ״מעבר לעוסק מורשה״, באותו תיק עסק. מסמכים שכבר הונפקו לא משתנים.";

export const NEW_BUSINESS_FILE_MESSAGE =
  "השם המשפטי, מספר העוסק / ח״פ וצורת ההתאגדות של תיק עסק לא משתנים לאחר שנקבעו — גם לא לתיקון טעות הקלדה. " +
  "כדי לעבוד עם פרטים משפטיים אחרים יש לפתוח תיק עסק חדש. התיק הנוכחי וכל המסמכים שהונפקו בו נשארים כפי שהם.";

export const AUTHORIZED_TO_EXEMPT_MESSAGE =
  "מעבר מעוסק מורשה לעוסק פטור אינו זמין בדוביז. אפשר לפנות לתמיכה.";

const normText = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ");
const normTaxId = (v: string | null | undefined) => authoritativeTaxId(v) ?? normText(v);

/** Individual (עוסק פטור / מורשה, ת.ז.) or company (ח״פ). Moving between them is a different legal entity. */
export function legalFormOf(kind: BillingBusinessKind): "INDIVIDUAL" | "COMPANY" {
  return kind === "LTD_COMPANY" ? "COMPANY" : "INDIVIDUAL";
}

/**
 * Classify a requested change of the legal identity. `before` is what the business file holds; `after` is what the
 * request asks for (a field left undefined means "not changing").
 *
 * Precedence: anything that makes it a different legal identity (name, id number, legal form) → NEW_BUSINESS_FILE,
 * even when the kind also changes. Only a pure exempt → authorized move with name and id number untouched is Path A.
 */
export function classifyIdentityChange(before: LegalIdentitySlice, after: Partial<LegalIdentitySlice>): IdentityChangeVerdict {
  const nextName = after.billingLegalName === undefined ? before.billingLegalName : after.billingLegalName;
  const nextTax = after.billingTaxId === undefined ? before.billingTaxId : after.billingTaxId;
  const nextKindRaw = after.billingBusinessKind === undefined ? before.billingBusinessKind : after.billingBusinessKind;

  const fromKind = parseBillingBusinessKind(before.billingBusinessKind);
  const toKind = parseBillingBusinessKind(nextKindRaw);
  const kindChanged = normText(before.billingBusinessKind) !== normText(nextKindRaw);

  // A business with no kind yet (an unconfirmed pilot business) choosing its first kind is not a change of legal
  // form; it stays on the existing, unlocked edit path. Any other unparseable kind on either side is refused.
  const firstKindChoice = !normText(before.billingBusinessKind) && toKind !== null;
  if (kindChanged && !firstKindChoice && (fromKind === null || toKind === null)) {
    return { path: "NOT_SUPPORTED", reason: "UNKNOWN_KIND", message: NEW_BUSINESS_FILE_MESSAGE };
  }

  const reasons: NewBusinessFileReason[] = [];
  if (normText(before.billingLegalName) && normText(before.billingLegalName) !== normText(nextName)) {
    reasons.push("LEGAL_NAME_CHANGED");
  }
  if (normText(before.billingTaxId) && normTaxId(before.billingTaxId) !== normTaxId(nextTax)) {
    reasons.push("TAX_ID_CHANGED");
  }
  if (fromKind && toKind && legalFormOf(fromKind) !== legalFormOf(toKind)) {
    reasons.push("LEGAL_FORM_CHANGED");
  }
  if (reasons.length > 0) return { path: "NEW_BUSINESS_FILE", reasons, message: NEW_BUSINESS_FILE_MESSAGE };

  if (fromKind && toKind && fromKind !== toKind) {
    if (fromKind === "EXEMPT_DEALER" && toKind === "AUTHORIZED_DEALER") {
      return { path: "KIND_TRANSITION", from: "EXEMPT_DEALER", to: "AUTHORIZED_DEALER", message: KIND_TRANSITION_MESSAGE };
    }
    if (fromKind === "AUTHORIZED_DEALER" && toKind === "EXEMPT_DEALER") {
      return { path: "NOT_SUPPORTED", reason: "AUTHORIZED_TO_EXEMPT", message: AUTHORIZED_TO_EXEMPT_MESSAGE };
    }
  }
  return { path: "NO_LEGAL_CHANGE" };
}

/** Hebrew label of a kind for messages; never the raw enum. */
export function kindLabel(kind: string | null | undefined): string {
  const k = parseBillingBusinessKind(kind);
  return k ? BILLING_BUSINESS_KIND_LABELS[k] : "";
}
