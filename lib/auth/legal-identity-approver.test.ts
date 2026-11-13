/**
 * The dedicated legal-identity approver permission (./legal-identity-approver.ts). Pure.
 *   node_modules/.bin/tsx lib/auth/legal-identity-approver.test.ts
 */
import assert from "node:assert/strict";

import { UserRole } from "@prisma/client";

import { maskTaxId, shortenName } from "@/lib/services/platform-admin/legal-identity-corrections.service";
import {
  INTERNAL_NOTE_MAX,
  normalizeDecisionNotes,
  normalizeInfoNote,
  statusForOutcome,
} from "@/lib/services/account/legal-identity-correction-admin.service";

import { isLegalIdentityApprover } from "./legal-identity-approver";

let n = 0;
function check(name: string, fn: () => void) {
  try { fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}

const ADMIN = { role: UserRole.PLATFORM_ADMIN, email: "Approver@Dubiz.invalid" };
process.env.PLATFORM_ADMIN_EMAILS = "approver@dubiz.invalid,other-admin@dubiz.invalid";

check("an admin on both lists is an approver (case-insensitive, trimmed)", () => {
  assert.equal(isLegalIdentityApprover(ADMIN, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: " approver@dubiz.invalid " }), true);
});
check("an admin NOT on the approver list is not an approver", () => {
  assert.equal(isLegalIdentityApprover({ ...ADMIN, email: "other-admin@dubiz.invalid" }, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: "approver@dubiz.invalid" }), false);
});
check("unset or empty approver list denies everyone (fail closed)", () => {
  assert.equal(isLegalIdentityApprover(ADMIN, {}), false);
  assert.equal(isLegalIdentityApprover(ADMIN, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: "  " }), false);
  assert.equal(isLegalIdentityApprover(ADMIN, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: " , " }), false);
});
check("a business user on the approver list is still not an approver (needs PLATFORM_ADMIN)", () => {
  assert.equal(isLegalIdentityApprover({ role: UserRole.USER, email: "approver@dubiz.invalid" }, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: "approver@dubiz.invalid" }), false);
});
check("an approver-listed PLATFORM_ADMIN missing from PLATFORM_ADMIN_EMAILS is not an approver", () => {
  assert.equal(isLegalIdentityApprover({ role: UserRole.PLATFORM_ADMIN, email: "rogue@dubiz.invalid" }, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: "rogue@dubiz.invalid" }), false);
});
check("no user → not an approver (never throws)", () => {
  assert.equal(isLegalIdentityApprover(null, { PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS: "approver@dubiz.invalid" }), false);
});

check("list masking: last 3 digits only; names shortened", () => {
  assert.equal(maskTaxId("512345678"), "••••••678");
  assert.equal(maskTaxId(null), null);
  assert.equal(maskTaxId("12"), "••");
  assert.equal(shortenName("מאפיית דנה בעמ שבע"), "מאפיית דנה ב…");
  assert.equal(shortenName("קצר"), "קצר");
});
check("decision notes: both required, bounded, trimmed", () => {
  assert.equal(normalizeDecisionNotes({ publicNote: "אושר", internalNote: "נבדק היטב" }), null, "public < 5");
  assert.deepEqual(normalizeDecisionNotes({ publicNote: "  אושר סופית ", internalNote: " נבדק היטב " }), { publicNote: "אושר סופית", internalNote: "נבדק היטב" });
  assert.equal(normalizeDecisionNotes({ publicNote: "אושר סופית", internalNote: "x".repeat(INTERNAL_NOTE_MAX + 1) }), null);
  assert.equal(normalizeDecisionNotes({ publicNote: 5, internalNote: "נבדק היטב" }), null);
  assert.equal(normalizeInfoNote("נא לצרף"), "נא לצרף");
  assert.equal(normalizeInfoNote("abc"), null);
});
check("outcome → HTTP status", () => {
  assert.equal(statusForOutcome("APPLIED"), 200);
  assert.equal(statusForOutcome("REQUESTED"), 200);
  assert.equal(statusForOutcome("STALE"), 409);
  assert.equal(statusForOutcome("NOT_PENDING"), 409);
  assert.equal(statusForOutcome("NOT_ALLOWED"), 403);
  assert.equal(statusForOutcome("NOT_FOUND"), 404);
  assert.equal(statusForOutcome("NOTE_REQUIRED"), 400);
});

console.log(`legal-identity-approver.test.ts: ok (${n} checks)`);
