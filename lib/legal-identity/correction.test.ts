/**
 * Legal identity correction rules (lib/legal-identity/correction.ts). Pure: no DB, no network.
 *   node_modules/.bin/tsx lib/legal-identity/correction.test.ts
 */
import assert from "node:assert/strict";

import {
  CorrectionValidationError,
  correctionCodeFromDbError,
  normalizeCorrection,
  type CorrectionField,
  type CurrentIdentity,
} from "./correction";

let n = 0;
function check(name: string, fn: () => void) {
  try { fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}
// Valid check digits, computed (not hand-typed).
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const A = withCheckDigit("03141592");
const B = withCheckDigit("27182818");
const BAD = A.slice(0, 8) + String((Number(A[8]) + 1) % 10);

const dealer: CurrentIdentity = { businessKind: "EXEMPT_DEALER", legalName: "דנה כהן", taxId: A };
const company: CurrentIdentity = { businessKind: "LTD_COMPANY", legalName: "דנה בע״מ", taxId: B };
const base = { requestedBusinessKind: "EXEMPT_DEALER", requestedLegalName: "דנה כהן-לוי", requestedTaxId: A, reason: "שגיאת הקלדה בשם בהרשמה", sameLegalEntity: true };

function refuses(cur: CurrentIdentity, input: Record<string, unknown>, field: CorrectionField, name: string, secret?: string) {
  check(name, () => {
    assert.throws(() => normalizeCorrection(cur, input), (e: unknown) => {
      assert.ok(e instanceof CorrectionValidationError);
      assert.equal(e.field, field);
      if (secret) assert.ok(!e.message.includes(secret), "the message repeats the typed value");
      return true;
    });
  });
}

check("typo in the legal name → TYPO_CORRECTION, values normalised", () => {
  const r = normalizeCorrection(dealer, { ...base, requestedLegalName: "  דנה   כהן-לוי " });
  assert.equal(r.kind, "TYPO_CORRECTION");
  assert.equal(r.requestedLegalName, "דנה כהן-לוי");
  assert.equal(r.requestedTaxId, A);
});
check("typo in the number (same entity) → TYPO_CORRECTION, separators accepted", () => {
  const r = normalizeCorrection(dealer, { ...base, requestedLegalName: "דנה כהן", requestedTaxId: `${B.slice(0, 2)}-${B.slice(2)}` });
  assert.equal(r.kind, "TYPO_CORRECTION");
  assert.equal(r.requestedTaxId, B);
});
check("exempt → authorized dealer, same number → BUSINESS_KIND_CHANGE", () => {
  const r = normalizeCorrection(dealer, { ...base, requestedBusinessKind: "AUTHORIZED_DEALER", requestedLegalName: "דנה כהן" });
  assert.equal(r.kind, "BUSINESS_KIND_CHANGE");
});
refuses(dealer, { ...base, requestedBusinessKind: "AUTHORIZED_DEALER", requestedTaxId: B }, "requestedTaxId",
  "a kind change that also changes the number is refused (two separate requests)", B);
refuses(dealer, { ...base, requestedBusinessKind: "LTD_COMPANY" }, "requestedBusinessKind", "individual → company is a different legal entity");
refuses(company, { ...base, requestedBusinessKind: "AUTHORIZED_DEALER", requestedTaxId: B }, "requestedBusinessKind", "company → individual is a different legal entity");
refuses(dealer, { ...base, requestedBusinessKind: "PARTNERSHIP" }, "requestedBusinessKind", "unknown kind refused");
refuses(dealer, { ...base, requestedLegalName: "x" }, "requestedLegalName", "legal name too short");
refuses(dealer, { ...base, requestedLegalName: "א".repeat(121) }, "requestedLegalName", "legal name over 120");
refuses(dealer, { ...base, requestedTaxId: BAD }, "requestedTaxId", "bad check digit refused, never repeated", BAD);
refuses(dealer, { ...base, requestedTaxId: "111111111" }, "requestedTaxId", "repeated digits refused", "111111111");
refuses(dealer, { ...base, reason: "קצר" }, "reason", "reason under 10 characters");
refuses(dealer, { ...base, reason: "א".repeat(1001) }, "reason", "reason over 1000 characters");
refuses(dealer, { ...base, sameLegalEntity: "true" }, "sameLegalEntity", "the same-entity confirmation must be exactly true");
refuses(dealer, { ...base, sameLegalEntity: false }, "sameLegalEntity", "a different entity is never a correction");
refuses(dealer, { ...base, requestedLegalName: "דנה כהן" }, "noChange", "identical values are refused");
check("the client cannot choose the kind of request: it is derived", () => {
  const r = normalizeCorrection(dealer, { ...base, kind: "BUSINESS_KIND_CHANGE" } as never);
  assert.equal(r.kind, "TYPO_CORRECTION");
});
check("database refusals map to stable codes without values", () => {
  assert.equal(correctionCodeFromDbError(new Error("DZC06 LEGAL_IDENTITY_CORRECTION_ALREADY_OPEN")), "CORRECTION_ALREADY_OPEN");
  assert.equal(correctionCodeFromDbError(new Error('duplicate key value violates unique constraint "LegalIdentityCorrection_one_open_per_business"')), "CORRECTION_ALREADY_OPEN");
  assert.equal(correctionCodeFromDbError(new Error("DZC02 LEGAL_IDENTITY_CORRECTION_VERIFICATION_STALE")), "VERIFICATION_STALE");
  assert.equal(correctionCodeFromDbError(new Error("DZC03")), "DIFFERENT_LEGAL_ENTITY");
  assert.equal(correctionCodeFromDbError(new Error("DZC05")), "CORRECTION_KIND_RULE");
  assert.equal(correctionCodeFromDbError(new Error("DZC04 detail taxId")), "CORRECTION_INVALID");
  assert.equal(correctionCodeFromDbError(new Error("DZC01 LEGAL_IDENTITY_NOT_CONFIRMED")), "IDENTITY_NOT_CONFIRMED");
  assert.equal(correctionCodeFromDbError(new Error("DZC01 LEGAL_IDENTITY_CORRECTION_NOT_ALLOWED")), "NOT_ALLOWED");
  assert.equal(correctionCodeFromDbError(new Error("connection reset")), null);
});

console.log(`correction.test.ts: ok (${n} checks)`);
