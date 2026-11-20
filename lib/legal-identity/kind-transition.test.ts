/**
 * Verify — Path A "מעבר לעוסק מורשה" pure core (lib/legal-identity/kind-transition.ts): eligibility, input
 * validation (same entity, VAT number, every acknowledgement), the canonical statement and its digest.
 * Run: npx tsx lib/legal-identity/kind-transition.test.ts
 *
 * Pure: no database. The write (a separately approved database function) is not built; nothing here writes.
 */
import assert from "node:assert/strict";

import {
  KIND_TRANSITION_ACKNOWLEDGEMENTS,
  KIND_TRANSITION_STATEMENT_VERSION,
  canonicalKindTransitionStatement,
  evaluateKindTransitionEligibility,
  kindTransitionStatementSha256,
  validateKindTransitionInput,
  type KindTransitionState,
} from "@/lib/legal-identity/kind-transition";

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

const TAX = "123456782";
const TAX_OTHER = "000000018";
const ALL_ACKS = KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => a.id);
const base: KindTransitionState = {
  billingBusinessKind: "EXEMPT_DEALER",
  billingLegalName: "ישראל ישראלי",
  billingTaxId: TAX,
  billingVatNumber: null,
  businessBeingDeleted: false,
  actorIsAuthorizedUser: true,
};

// ---------------------------------------------------------------- eligibility
check("E1 an exempt dealer with a complete identity, authorized user → eligible", () => {
  assert.deepEqual(evaluateKindTransitionEligibility(base), { eligible: true });
});

check("E2 authorized dealer / company / no kind → NOT_EXEMPT_DEALER", () => {
  for (const k of ["AUTHORIZED_DEALER", "LTD_COMPANY", null, "", "PARTNERSHIP"]) {
    const r = evaluateKindTransitionEligibility({ ...base, billingBusinessKind: k });
    assert.ok(!r.eligible && r.block === "NOT_EXEMPT_DEALER", String(k));
  }
});

check("E3 business being deleted → blocked, before anything else", () => {
  const r = evaluateKindTransitionEligibility({ ...base, businessBeingDeleted: true, billingBusinessKind: "AUTHORIZED_DEALER" });
  assert.ok(!r.eligible && r.block === "BUSINESS_BEING_DELETED");
});

check("E4 a user who is not the authorized user → NOT_AUTHORIZED_USER", () => {
  const r = evaluateKindTransitionEligibility({ ...base, actorIsAuthorizedUser: false });
  assert.ok(!r.eligible && r.block === "NOT_AUTHORIZED_USER");
});

check("E5 missing legal name or invalid id number on the file → IDENTITY_INCOMPLETE", () => {
  for (const patch of [{ billingLegalName: "" }, { billingLegalName: null }, { billingTaxId: "123456789" }, { billingTaxId: null }]) {
    const r = evaluateKindTransitionEligibility({ ...base, ...patch });
    assert.ok(!r.eligible && r.block === "IDENTITY_INCOMPLETE", JSON.stringify(patch));
  }
});

// ---------------------------------------------------------------- input validation
check("V1 correct id retyped, VAT = id, every acknowledgement → ok with canonical numbers", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: "12345678-2", vatNumber: " 123456782 ", acknowledged: ALL_ACKS });
  assert.deepEqual(r, { ok: true, vatNumber: TAX, taxId: TAX });
});

check("V2 a different id retyped → MISMATCH (same entity proof), never edits the file", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: TAX_OTHER, vatNumber: TAX, acknowledged: ALL_ACKS });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "confirmTaxId" && p.code === "MISMATCH"));
});

check("V3 empty fields → REQUIRED for both, every problem at once", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: " ", vatNumber: "", acknowledged: [] });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.deepEqual(r.problems.map((p) => `${p.field}:${p.code}`).sort(), ["acknowledged:INCOMPLETE", "confirmTaxId:REQUIRED", "vatNumber:REQUIRED"]);
  }
});

check("V4 a VAT number with a wrong check digit → INVALID", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: TAX, vatNumber: "123456789", acknowledged: ALL_ACKS });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "vatNumber" && p.code === "INVALID"));
});

check("V5 a valid VAT number different from the id → refused by default (DIFFERS_FROM_TAX_ID)", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: TAX, vatNumber: TAX_OTHER, acknowledged: ALL_ACKS });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "vatNumber" && p.code === "DIFFERS_FROM_TAX_ID"));
});

check("V6 …and accepted only if the owner relaxes the rule (policy switch)", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: TAX, vatNumber: TAX_OTHER, acknowledged: ALL_ACKS }, { vatMustEqualTaxId: false });
  assert.deepEqual(r, { ok: true, vatNumber: TAX_OTHER, taxId: TAX });
});

check("V7 one acknowledgement missing, or an unknown one added → INCOMPLETE (no partial consent)", () => {
  for (const acks of [ALL_ACKS.slice(1), [...ALL_ACKS, "something_else"]]) {
    const r = validateKindTransitionInput(base, { confirmTaxId: TAX, vatNumber: TAX, acknowledged: acks });
    assert.ok(!r.ok && r.problems.some((p) => p.field === "acknowledged"));
  }
});

check("V8 a file with no valid id number cannot pass validation at all", () => {
  const r = validateKindTransitionInput({ billingTaxId: null }, { confirmTaxId: TAX, vatNumber: TAX, acknowledged: ALL_ACKS });
  assert.equal(r.ok, false);
});

check("V9 no problem message echoes a typed value", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: "000000026", vatNumber: "999999998", acknowledged: [] });
  assert.ok(!r.ok);
  if (!r.ok) for (const p of r.problems) assert.ok(!p.message.includes("000000026") && !p.message.includes("999999998"));
});

// ---------------------------------------------------------------- statement
const fields = { businessId: 7, actorUserId: 11, legalName: " ישראל  ישראלי ", taxId: "12345678-2", vatNumber: TAX };

check("S1 canonical statement: versioned, normalised, fixed order, lists every acknowledgement", () => {
  const s = canonicalKindTransitionStatement(fields);
  const lines = s.split("\n");
  assert.equal(lines[0], `statement=${KIND_TRANSITION_STATEMENT_VERSION}`);
  assert.ok(lines.includes("legalName=ישראל ישראלי"));
  assert.ok(lines.includes(`taxId=${TAX}`));
  assert.ok(lines.includes("from=EXEMPT_DEALER") && lines.includes("to=AUTHORIZED_DEALER"));
  assert.equal(lines.filter((l) => l.startsWith("ack=")).length, KIND_TRANSITION_ACKNOWLEDGEMENTS.length);
});

check("S2 digest is stable across formatting and changes with any material field", () => {
  const h = kindTransitionStatementSha256(fields);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(kindTransitionStatementSha256({ ...fields, legalName: "ישראל ישראלי", taxId: TAX }), h);
  for (const patch of [{ businessId: 8 }, { actorUserId: 12 }, { legalName: "ישראל ישראלו" }, { vatNumber: TAX_OTHER }]) {
    assert.notEqual(kindTransitionStatementSha256({ ...fields, ...patch }), h, JSON.stringify(patch));
  }
});

console.log(`kind-transition: ${checks} checks passed`);
