/**
 * Verify — the legal-identity lock as the billing profile route applies it (lib/billing/legal-identity-lock.ts).
 * Run: npx tsx lib/billing/legal-identity-lock.test.ts
 *
 * Pure: no database (the database trigger BusinessProfile_legal_identity_lock is proved in .sli/battery.ts).
 */
import assert from "node:assert/strict";

import { AppError, ConflictError } from "@/lib/errors";
import {
  LEGAL_IDENTITY_LOCKED_CODE,
  LOCKED_LEGAL_IDENTITY_FIELDS,
  LegalIdentityLockedError,
  applyLegalIdentityLock,
  isLegalIdentityLockDbError,
} from "@/lib/billing/legal-identity-lock";

let checks = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`FAIL - ${label}`);
    throw e;
  }
  checks += 1;
}

const CONFIRMED = new Date("2026-11-12T10:00:00Z");
const before = { billingBusinessKind: "LTD_COMPANY", billingLegalName: "דנה בע״מ", billingTaxId: "514123454" };

function main() {
  check("the locked fields are exactly kind, legal name and tax id", () => {
    assert.deepEqual([...LOCKED_LEGAL_IDENTITY_FIELDS], ["billingBusinessKind", "billingLegalName", "billingTaxId"]);
  });

  check("unconfirmed (every existing business): the payload passes through untouched", () => {
    const persist = { billingBusinessKind: "EXEMPT_DEALER", billingLegalName: "אחר", billingTaxId: "000000018", billingPhone: "1" };
    for (const at of [null, undefined]) assert.deepEqual(applyLegalIdentityLock(at, before, persist), persist);
  });

  check("confirmed: locked fields re-sent unchanged are dropped from the write; others kept", () => {
    const persist = { ...before, billingPhone: "0501234567", billingAddress: "יפו 5", billingEmail: "a@b.co" };
    assert.deepEqual(applyLegalIdentityLock(CONFIRMED, before, persist), {
      billingPhone: "0501234567", billingAddress: "יפו 5", billingEmail: "a@b.co",
    });
  });

  check("confirmed: the same tax id in another spelling is the same number (dropped, not refused)", () => {
    for (const spelling of ["51-412345-4", " 514123454 ", "51 412 345 4", "51.412345.4"]) {
      assert.deepEqual(applyLegalIdentityLock(CONFIRMED, before, { billingTaxId: spelling }), {}, spelling);
    }
  });

  check("confirmed: the same legal name with different spacing is unchanged", () => {
    assert.deepEqual(applyLegalIdentityLock(CONFIRMED, before, { billingLegalName: "  דנה   בע״מ " }), {});
  });

  check("confirmed: non-locked fields are never touched, including the VAT number", () => {
    const persist = { billingVatNumber: "123", billingFooterNote: null, billingPdfTemplateStyle: "MODERN" };
    assert.deepEqual(applyLegalIdentityLock(CONFIRMED, before, persist), persist);
  });

  for (const [field, value] of [
    ["billingBusinessKind", "AUTHORIZED_DEALER"],
    ["billingLegalName", "שם אחר"],
    ["billingTaxId", "000000018"],
    ["billingTaxId", null],
    ["billingLegalName", null],
  ] as const) {
    check(`confirmed: changing ${field} to ${value === null ? "null" : "another value"} refuses the request`, () => {
      assert.throws(
        () => applyLegalIdentityLock(CONFIRMED, before, { [field]: value, billingPhone: "0501234567" }),
        (e: unknown) => {
          assert.ok(e instanceof LegalIdentityLockedError);
          assert.ok(e instanceof ConflictError && e instanceof AppError);
          assert.equal(e.statusCode, 409);
          assert.equal(e.code, LEGAL_IDENTITY_LOCKED_CODE);
          assert.deepEqual(e.fields, [field]);
          if (typeof value === "string") assert.ok(!e.message.includes(value), "the message echoes the value");
          assert.match(e.message, /[֐-׿]/, "a Hebrew message for the person");
          return true;
        }
      );
    });
  }

  check("confirmed: several changed fields are all named", () => {
    assert.throws(
      () => applyLegalIdentityLock(CONFIRMED, before, { billingBusinessKind: "EXEMPT_DEALER", billingTaxId: "000000018" }),
      (e: unknown) => e instanceof LegalIdentityLockedError && JSON.stringify(e.fields) === JSON.stringify(["billingBusinessKind", "billingTaxId"])
    );
  });

  check("confirmed but no row read (null before): any locked value is a change", () => {
    assert.throws(() => applyLegalIdentityLock(CONFIRMED, null, { billingLegalName: "x" }), LegalIdentityLockedError);
  });

  check("the input object is never mutated", () => {
    const persist = { ...before, billingPhone: "1" };
    const copy = { ...persist };
    applyLegalIdentityLock(CONFIRMED, before, persist);
    assert.deepEqual(persist, copy);
  });

  check("database refusals are recognised (DZL04 lock, DZL03 server-owned state)", () => {
    assert.equal(isLegalIdentityLockDbError(new Error('ERROR: LEGAL_IDENTITY_LOCKED (SQLSTATE DZL04)')), true);
    assert.equal(isLegalIdentityLockDbError(new Error("Raw query failed. Code: `DZL03`. Message: `LEGAL_IDENTITY_STATE_IS_SERVER_OWNED`")), true);
    assert.equal(isLegalIdentityLockDbError(new Error("ISSUER_PROFILE_IDENTITY_LOCKED DZD35")), false);
    assert.equal(isLegalIdentityLockDbError(new Error("connection refused")), false);
    assert.equal(isLegalIdentityLockDbError("DZL04"), false);
    assert.equal(isLegalIdentityLockDbError(undefined), false);
  });

  console.log(`legal-identity-lock.test.ts: ok (${checks} checks)`);
}

main();
