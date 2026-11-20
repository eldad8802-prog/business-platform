/**
 * Verify — the legal identity change policy (owner decision 2026-11-20): exempt → authorized is Path A (same file);
 * any change of legal name / id number / legal form is Path B (a new business file); nothing else changes identity.
 * Run: npx tsx lib/legal-identity/identity-change-policy.test.ts
 *
 * Pure: no database.
 */
import assert from "node:assert/strict";

import { classifyIdentityChange, legalFormOf } from "@/lib/legal-identity/identity-change-policy";

let checks = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    checks += 1;
  } catch (e) {
    console.error(`FAIL ${label}`);
    throw e;
  }
}

const TAX = "123456782"; // valid check digit
const TAX_OTHER = "000000018"; // valid, different
const exempt = { billingBusinessKind: "EXEMPT_DEALER", billingLegalName: "ישראל ישראלי", billingTaxId: TAX };
const authorized = { ...exempt, billingBusinessKind: "AUTHORIZED_DEALER" };

check("P1 nothing changes → NO_LEGAL_CHANGE", () => {
  assert.equal(classifyIdentityChange(exempt, {}).path, "NO_LEGAL_CHANGE");
  assert.equal(classifyIdentityChange(exempt, { ...exempt }).path, "NO_LEGAL_CHANGE");
});

check("P2 formatting only (spaces, dashes in the id) → NO_LEGAL_CHANGE", () => {
  assert.equal(classifyIdentityChange(exempt, { billingLegalName: "  ישראל   ישראלי " }).path, "NO_LEGAL_CHANGE");
  assert.equal(classifyIdentityChange(exempt, { billingTaxId: "12345678-2" }).path, "NO_LEGAL_CHANGE");
});

check("P3 exempt → authorized, same name and id → KIND_TRANSITION (Path A)", () => {
  const v = classifyIdentityChange(exempt, { billingBusinessKind: "AUTHORIZED_DEALER" });
  assert.equal(v.path, "KIND_TRANSITION");
});

check("P4 a one-letter typo fix in the legal name → NEW_BUSINESS_FILE (Path B, owner: even a typo)", () => {
  const v = classifyIdentityChange(exempt, { billingLegalName: "ישראל ישראלו" });
  assert.equal(v.path, "NEW_BUSINESS_FILE");
  assert.ok(v.path === "NEW_BUSINESS_FILE" && v.reasons.includes("LEGAL_NAME_CHANGED"));
});

check("P5 a one-digit change in the id number → NEW_BUSINESS_FILE", () => {
  const v = classifyIdentityChange(authorized, { billingTaxId: TAX_OTHER });
  assert.ok(v.path === "NEW_BUSINESS_FILE" && v.reasons.includes("TAX_ID_CHANGED"));
});

check("P6 individual → company (and back) is a different legal entity → NEW_BUSINESS_FILE", () => {
  for (const [from, to] of [
    [exempt, "LTD_COMPANY"],
    [authorized, "LTD_COMPANY"],
    [{ ...exempt, billingBusinessKind: "LTD_COMPANY" }, "AUTHORIZED_DEALER"],
  ] as const) {
    const v = classifyIdentityChange(from, { billingBusinessKind: to });
    assert.ok(v.path === "NEW_BUSINESS_FILE" && v.reasons.includes("LEGAL_FORM_CHANGED"), `${from.billingBusinessKind}→${to}`);
  }
});

check("P7 exempt → authorized together with a name change → NEW_BUSINESS_FILE wins (never Path A)", () => {
  const v = classifyIdentityChange(exempt, { billingBusinessKind: "AUTHORIZED_DEALER", billingLegalName: "שם אחר" });
  assert.equal(v.path, "NEW_BUSINESS_FILE");
});

check("P8 authorized → exempt has no path (owner decision pending) → NOT_SUPPORTED", () => {
  const v = classifyIdentityChange(authorized, { billingBusinessKind: "EXEMPT_DEALER" });
  assert.ok(v.path === "NOT_SUPPORTED" && v.reason === "AUTHORIZED_TO_EXEMPT");
});

check("P9 an unknown kind value → NOT_SUPPORTED", () => {
  assert.equal(classifyIdentityChange(exempt, { billingBusinessKind: "PARTNERSHIP" }).path, "NOT_SUPPORTED");
});

check("P10 a pilot business with no identity yet choosing its first values → NO_LEGAL_CHANGE (unlocked path)", () => {
  const empty = { billingBusinessKind: null, billingLegalName: null, billingTaxId: null };
  assert.equal(classifyIdentityChange(empty, exempt).path, "NO_LEGAL_CHANGE");
});

check("P11 clearing the legal name or the id number counts as a change → NEW_BUSINESS_FILE", () => {
  assert.equal(classifyIdentityChange(exempt, { billingLegalName: "" }).path, "NEW_BUSINESS_FILE");
  assert.equal(classifyIdentityChange(exempt, { billingTaxId: null }).path, "NEW_BUSINESS_FILE");
});

check("P12 messages never carry a typed value", () => {
  const v = classifyIdentityChange(exempt, { billingLegalName: "שם-סודי-123", billingTaxId: TAX_OTHER });
  assert.ok(v.path === "NEW_BUSINESS_FILE");
  if (v.path === "NEW_BUSINESS_FILE") {
    assert.ok(!v.message.includes("שם-סודי-123"));
    assert.ok(!v.message.includes(TAX_OTHER));
  }
});

check("P13 legal form mapping", () => {
  assert.equal(legalFormOf("EXEMPT_DEALER"), "INDIVIDUAL");
  assert.equal(legalFormOf("AUTHORIZED_DEALER"), "INDIVIDUAL");
  assert.equal(legalFormOf("LTD_COMPANY"), "COMPANY");
});

console.log(`identity-change-policy: ${checks} checks passed`);
