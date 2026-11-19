/**
 * Verify — the legal identity collected at signup (lib/auth/signup-legal-identity.ts).
 * Run: npx tsx lib/auth/signup-legal-identity.test.ts
 *
 * Pure: no database. Proves what is persisted (canonical tax id, collapsed text, normalised phone, lower-case
 * email), that every field names itself, that the labels follow the kind, and that no message ever carries the
 * value the person typed (an individual's dealer number is usually their national ID).
 */
import assert from "node:assert/strict";

import {
  LegalIdentityValidationError,
  TRADE_NAME_MAX,
  displayNameFor,
  legalIdentityFieldErrors,
  legalIdentityLabels,
  normalizeLegalIdentity,
  normalizePhone,
  type LegalIdentityKind,
} from "@/lib/auth/signup-legal-identity";
import { authoritativeTaxId } from "@/lib/identity/tax-id";

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

/** A valid nine-digit number built from eight digits — computed, never hand-typed. */
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return eight + String((10 - (sum % 10)) % 10);
}
const VALID_TAX = withCheckDigit("51412345");
const BAD_TAX = VALID_TAX.slice(0, 8) + String((Number(VALID_TAX[8]) + 1) % 10);

const valid = {
  legalName: "דנה כהן",
  taxId: VALID_TAX,
  address: "הרצל 1, תל אביב",
  phone: "0501234567",
  businessEmail: "biz@lab.invalid",
};

function refuses(kind: LegalIdentityKind, input: Record<string, unknown>, field: string, label: string, mustNotContain?: string) {
  check(label, () => {
    assert.throws(
      () => normalizeLegalIdentity(kind, input as never),
      (err: unknown) => {
        assert.ok(err instanceof LegalIdentityValidationError, `${label}: expected LegalIdentityValidationError`);
        assert.equal(err.field, field, `${label}: wrong field`);
        if (mustNotContain) assert.ok(!err.message.includes(mustNotContain), `${label}: the message echoes the value`);
        return true;
      }
    );
  });
}

function main() {
  // ── happy path, per kind ──
  for (const kind of ["EXEMPT_DEALER", "AUTHORIZED_DEALER", "LTD_COMPANY"] as const) {
    check(`${kind}: a valid identity normalizes`, () => {
      const out = normalizeLegalIdentity(kind, valid);
      assert.deepEqual(out, { kind, ...valid, tradeName: null });
    });
  }

  // ── labels follow the kind ──
  check("labels: a dealer is asked for the owner's legal name and the dealer number", () => {
    for (const k of ["EXEMPT_DEALER", "AUTHORIZED_DEALER"] as const) {
      assert.deepEqual(legalIdentityLabels(k), { legalName: "שם משפטי של בעל העסק", taxId: "מספר עוסק", address: "כתובת העסק" });
    }
  });
  check("labels: a company is asked for the company's legal name and its ח״פ", () => {
    assert.deepEqual(legalIdentityLabels("LTD_COMPANY"), { legalName: "שם החברה המשפטי", taxId: "מספר ח״פ", address: "כתובת החברה" });
  });
  check("labels reach the errors", () => {
    assert.match(legalIdentityFieldErrors("LTD_COMPANY", { ...valid, taxId: "" }).taxId ?? "", /ח״פ/);
    assert.match(legalIdentityFieldErrors("EXEMPT_DEALER", { ...valid, taxId: "" }).taxId ?? "", /מספר עוסק/);
  });

  // ── tax id ──
  check("tax id: separators are removed and the canonical nine digits kept", () => {
    const dashed = `${VALID_TAX.slice(0, 2)}-${VALID_TAX.slice(2, 8)}-${VALID_TAX[8]}`;
    assert.equal(normalizeLegalIdentity("LTD_COMPANY", { ...valid, taxId: ` ${dashed} ` }).taxId, VALID_TAX);
    assert.equal(normalizeLegalIdentity("LTD_COMPANY", { ...valid, taxId: VALID_TAX.replace(/(\d{3})/g, "$1 ") }).taxId, VALID_TAX);
  });
  check("tax id: eight digits (a dropped leading zero) are padded", () => {
    assert.equal(normalizeLegalIdentity("AUTHORIZED_DEALER", { ...valid, taxId: "00000018".slice(0) }).taxId, "000000018");
    assert.equal(normalizeLegalIdentity("AUTHORIZED_DEALER", { ...valid, taxId: "00000018" }).taxId, authoritativeTaxId("00000018"));
  });
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: BAD_TAX }, "taxId", "tax id: a wrong check digit is refused, without echoing it", BAD_TAX);
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "111111111" }, "taxId", "tax id: one repeated digit is refused", "111111111");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "000000000" }, "taxId", "tax id: all zeros is refused");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "1234567" }, "taxId", "tax id: seven digits are refused", "1234567");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "1234567890" }, "taxId", "tax id: ten digits are refused", "1234567890");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "51A123456" }, "taxId", "tax id: letters are refused");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: "" }, "taxId", "tax id: empty is refused");
  refuses("AUTHORIZED_DEALER", { ...valid, taxId: 514123456 }, "taxId", "tax id: a number type is refused (not a string)");

  // ── legal name ──
  check("legal name: inner whitespace collapsed, ends trimmed", () => {
    assert.equal(normalizeLegalIdentity("EXEMPT_DEALER", { ...valid, legalName: "  דנה    כהן " }).legalName, "דנה כהן");
  });
  refuses("EXEMPT_DEALER", { ...valid, legalName: undefined }, "legalName", "legal name: missing");
  refuses("EXEMPT_DEALER", { ...valid, legalName: " א " }, "legalName", "legal name: one character");
  refuses("EXEMPT_DEALER", { ...valid, legalName: "א".repeat(121) }, "legalName", "legal name: over 120 (the issuer declaration bound)");
  check("legal name: exactly 120 is accepted", () => {
    assert.equal(normalizeLegalIdentity("EXEMPT_DEALER", { ...valid, legalName: "א".repeat(120) }).legalName.length, 120);
  });

  // ── trade name (optional) ──
  check("trade name: absent, null or empty means none", () => {
    for (const t of [undefined, null, "", "   "]) {
      assert.equal(normalizeLegalIdentity("AUTHORIZED_DEALER", { ...valid, tradeName: t }).tradeName, null);
    }
  });
  check("trade name: kept, collapsed", () => {
    assert.equal(normalizeLegalIdentity("AUTHORIZED_DEALER", { ...valid, tradeName: " סטודיו   דנה " }).tradeName, "סטודיו דנה");
  });
  refuses("AUTHORIZED_DEALER", { ...valid, tradeName: "א" }, "tradeName", "trade name: one character is refused");
  refuses("AUTHORIZED_DEALER", { ...valid, tradeName: "א".repeat(TRADE_NAME_MAX + 1) }, "tradeName", "trade name: over 120 is refused");
  refuses("AUTHORIZED_DEALER", { ...valid, tradeName: 7 }, "tradeName", "trade name: a non-string is refused");
  check("display name: the trade name when there is one, else the legal name (≤120)", () => {
    assert.equal(displayNameFor({ legalName: "דנה כהן", tradeName: "סטודיו דנה" }), "סטודיו דנה");
    assert.equal(displayNameFor({ legalName: "דנה כהן", tradeName: null }), "דנה כהן");
    assert.equal(displayNameFor({ legalName: "א".repeat(200), tradeName: null }).length, TRADE_NAME_MAX);
  });

  // ── address ──
  refuses("LTD_COMPANY", { ...valid, address: "" }, "address", "address: empty");
  refuses("LTD_COMPANY", { ...valid, address: "א".repeat(301) }, "address", "address: over 300");
  check("address: collapsed", () => {
    assert.equal(normalizeLegalIdentity("LTD_COMPANY", { ...valid, address: " הרצל  1 ,  תל אביב " }).address, "הרצל 1 , תל אביב");
  });

  // ── phone ──
  check("phone: separators removed, a leading + kept", () => {
    assert.equal(normalizePhone("050-123-4567"), "0501234567");
    assert.equal(normalizePhone("(03) 123 4567"), "031234567");
    assert.equal(normalizePhone("+972 50 123 4567"), "+972501234567");
    assert.equal(normalizeLegalIdentity("EXEMPT_DEALER", { ...valid, phone: "050 123 4567" }).phone, "0501234567");
  });
  for (const bad of ["abc", "123", "+", "12345678", "0501234567890123", "050-12a-4567"]) {
    refuses("EXEMPT_DEALER", { ...valid, phone: bad }, "phone", `phone: "${bad}" is refused`, bad.length > 3 ? bad : undefined);
  }

  // ── business email ──
  check("business email: trimmed and lower-cased", () => {
    assert.equal(normalizeLegalIdentity("EXEMPT_DEALER", { ...valid, businessEmail: "  Biz@Lab.INVALID " }).businessEmail, "biz@lab.invalid");
  });
  for (const bad of ["", "no-at", "a@b", "a b@c.com", `${"a".repeat(320)}@x.co`]) {
    refuses("EXEMPT_DEALER", { ...valid, businessEmail: bad }, "businessEmail", `business email: "${bad.slice(0, 12)}" is refused`);
  }

  // ── every error at once (legalIdentityFieldErrors) ──
  check("field errors: a valid identity has none", () => {
    assert.deepEqual(legalIdentityFieldErrors("AUTHORIZED_DEALER", valid), {});
  });
  check("field errors: every invalid field is reported at once, in form order", () => {
    const errors = legalIdentityFieldErrors("AUTHORIZED_DEALER", {
      legalName: "", taxId: BAD_TAX, tradeName: "א", address: "", phone: "x", businessEmail: "no",
    });
    assert.deepEqual(Object.keys(errors), ["legalName", "taxId", "tradeName", "address", "phone", "businessEmail"]);
  });
  check("field errors: an empty body names every required field (trade name stays optional)", () => {
    assert.deepEqual(Object.keys(legalIdentityFieldErrors("LTD_COMPANY", {})), ["legalName", "taxId", "address", "phone", "businessEmail"]);
  });
  check("field errors: no message contains the typed value", () => {
    const typed = { legalName: "א".repeat(201), taxId: BAD_TAX, tradeName: "ב".repeat(121), address: "ג".repeat(301), phone: "0501234567890123", businessEmail: "secret-person@nodot" };
    const errors = legalIdentityFieldErrors("EXEMPT_DEALER", typed);
    for (const [field, message] of Object.entries(errors)) {
      assert.ok(!message!.includes(String(typed[field as keyof typeof typed])), `${field} message echoes the value`);
    }
    assert.equal(Object.keys(errors).length, 6);
  });
  check("field errors and normalize agree: normalize throws the FIRST field error, same message", () => {
    const input = { ...valid, taxId: BAD_TAX, phone: "x" };
    const errors = legalIdentityFieldErrors("AUTHORIZED_DEALER", input);
    assert.throws(() => normalizeLegalIdentity("AUTHORIZED_DEALER", input), (e: unknown) =>
      e instanceof LegalIdentityValidationError && e.field === "taxId" && e.message === errors.taxId);
  });
  check("an undefined input is refused naming the first field, never a raw TypeError", () => {
    assert.throws(() => normalizeLegalIdentity("AUTHORIZED_DEALER", undefined as never),
      (e: unknown) => e instanceof LegalIdentityValidationError && e.field === "legalName");
  });

  console.log(`signup-legal-identity.test.ts: ok (${checks} checks)`);
}

main();
