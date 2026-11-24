/**
 * Verify — Path A "מעבר לעוסק מורשה" pure core (lib/legal-identity/kind-transition.ts): eligibility, input
 * validation (same entity, VAT number = id number, the status start date, every acknowledgement), the canonical
 * statement and its digest (pinned to the vector the migration computes in SQL), the database answer mapping.
 * Run: npx tsx lib/legal-identity/kind-transition.test.ts
 *
 * Pure: no database (the database half is .bkt/battery.ts in business-kind-transition-lab.yml).
 */
import assert from "node:assert/strict";

import {
  KIND_TRANSITION_ACKNOWLEDGEMENTS,
  KIND_TRANSITION_BLOCK_MESSAGES,
  KIND_TRANSITION_DECLARATION_MESSAGES,
  KIND_TRANSITION_STATEMENT_VERSION,
  KIND_TRANSITION_VECTOR,
  canonicalKindTransitionStatement,
  evaluateKindTransitionEligibility,
  israelToday,
  kindTransitionOutcome,
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
const TODAY = "2026-11-20";
const base: KindTransitionState = {
  billingBusinessKind: "EXEMPT_DEALER",
  billingLegalName: "ישראל ישראלי",
  billingTaxId: TAX,
  billingVatNumber: null,
  businessBeingDeleted: false,
  actorIsSoleUser: true,
  hasLiveIssuerDeclaration: false,
};
const input = (over: Partial<Parameters<typeof validateKindTransitionInput>[1]> = {}) => ({
  confirmTaxId: TAX, vatNumber: TAX, statusEffectiveDate: "2026-11-01", acknowledged: ALL_ACKS as string[], ...over,
});

// ---------------------------------------------------------------- eligibility
check("E1 an exempt dealer, complete identity, sole user, no declaration → eligible", () => {
  assert.deepEqual(evaluateKindTransitionEligibility(base), { eligible: true });
});

check("E2 authorized dealer / company / no kind → NOT_EXEMPT_DEALER (authorized → exempt stays blocked)", () => {
  for (const k of ["AUTHORIZED_DEALER", "LTD_COMPANY", null, "", "PARTNERSHIP"]) {
    const r = evaluateKindTransitionEligibility({ ...base, billingBusinessKind: k });
    assert.ok(!r.eligible && r.block === "NOT_EXEMPT_DEALER", String(k));
  }
});

check("E3 business being deleted → blocked first", () => {
  const r = evaluateKindTransitionEligibility({ ...base, businessBeingDeleted: true, billingBusinessKind: "AUTHORIZED_DEALER" });
  assert.ok(!r.eligible && r.block === "BUSINESS_BEING_DELETED");
});

check("E4 several users → NOT_SOLE_USER (never 'the first user')", () => {
  const r = evaluateKindTransitionEligibility({ ...base, actorIsSoleUser: false });
  assert.ok(!r.eligible && r.block === "NOT_SOLE_USER");
});

check("E5 missing name, invalid id, or an id stored in a non-canonical form → IDENTITY_INCOMPLETE", () => {
  for (const patch of [{ billingLegalName: "" }, { billingLegalName: null }, { billingTaxId: "123456789" }, { billingTaxId: null }, { billingTaxId: "12345678-2" }]) {
    const r = evaluateKindTransitionEligibility({ ...base, ...patch });
    assert.ok(!r.eligible && r.block === "IDENTITY_INCOMPLETE", JSON.stringify(patch));
  }
});

check("E6 a live issuer declaration no longer blocks (4a T1 wiring: the database files the declaration's new version)", () => {
  assert.deepEqual(evaluateKindTransitionEligibility({ ...base, hasLiveIssuerDeclaration: true }), { eligible: true });
  // ...and it never lifts any other block
  for (const patch of [{ actorIsSoleUser: false }, { billingBusinessKind: "AUTHORIZED_DEALER" }, { businessBeingDeleted: true }, { billingLegalName: "" }, { billingTaxId: "123456789" }]) {
    const r = evaluateKindTransitionEligibility({ ...base, hasLiveIssuerDeclaration: true, ...patch });
    assert.ok(!r.eligible, JSON.stringify(patch));
  }
  assert.ok(!("ISSUER_DECLARATION_ACTIVE" in KIND_TRANSITION_BLOCK_MESSAGES));
});

// ---------------------------------------------------------------- input validation
check("V1 correct id retyped, VAT = id, a past start date, every acknowledgement → ok, canonical values", () => {
  const r = validateKindTransitionInput(base, input({ confirmTaxId: "12345678-2", vatNumber: " 123456782 " }), { today: TODAY });
  assert.deepEqual(r, { ok: true, vatNumber: TAX, taxId: TAX, statusEffectiveDate: "2026-11-01" });
});

check("V2 a different id retyped → MISMATCH (same-entity proof)", () => {
  const r = validateKindTransitionInput(base, input({ confirmTaxId: TAX_OTHER }), { today: TODAY });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "confirmTaxId" && p.code === "MISMATCH"));
});

check("V3 everything empty → every problem at once", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: " ", vatNumber: "", statusEffectiveDate: "", acknowledged: [] }, { today: TODAY });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.deepEqual(r.problems.map((p) => `${p.field}:${p.code}`).sort(),
      ["acknowledged:INCOMPLETE", "confirmTaxId:REQUIRED", "statusEffectiveDate:REQUIRED", "vatNumber:REQUIRED"]);
  }
});

check("V4 a VAT number with a wrong check digit → INVALID", () => {
  const r = validateKindTransitionInput(base, input({ vatNumber: "123456789" }), { today: TODAY });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "vatNumber" && p.code === "INVALID"));
});

check("V5 a valid VAT number different from the id → DIFFERS_FROM_TAX_ID (owner 11-20: always required)", () => {
  const r = validateKindTransitionInput(base, input({ vatNumber: TAX_OTHER }), { today: TODAY });
  assert.ok(!r.ok && r.problems.some((p) => p.field === "vatNumber" && p.code === "DIFFERS_FROM_TAX_ID"));
});

check("V6 start date: today ok; tomorrow IN_FUTURE; malformed / impossible / pre-2000 INVALID", () => {
  assert.equal(validateKindTransitionInput(base, input({ statusEffectiveDate: TODAY }), { today: TODAY }).ok, true);
  const code = (d: string) => {
    const r = validateKindTransitionInput(base, input({ statusEffectiveDate: d }), { today: TODAY });
    return r.ok ? "ok" : r.problems.find((p) => p.field === "statusEffectiveDate")?.code;
  };
  assert.equal(code("2026-11-21"), "IN_FUTURE");
  for (const d of ["20/11/2026", "2026-02-30", "2026-13-01", "1999-12-31", "abc"]) assert.equal(code(d), "INVALID", d);
});

check("V7 one acknowledgement missing, or an unknown one added → INCOMPLETE (no partial consent)", () => {
  for (const acks of [ALL_ACKS.slice(1), [...ALL_ACKS, "something_else"]]) {
    const r = validateKindTransitionInput(base, input({ acknowledged: acks }), { today: TODAY });
    assert.ok(!r.ok && r.problems.some((p) => p.field === "acknowledged"));
  }
});

check("V8 a file with no canonical id number cannot pass validation at all", () => {
  assert.equal(validateKindTransitionInput({ billingTaxId: null }, input(), { today: TODAY }).ok, false);
  assert.equal(validateKindTransitionInput({ billingTaxId: "12345678-2" }, input(), { today: TODAY }).ok, false);
});

check("V9 no problem message echoes a typed value", () => {
  const r = validateKindTransitionInput(base, { confirmTaxId: "000000026", vatNumber: "999999998", statusEffectiveDate: "2099-01-01", acknowledged: [] }, { today: TODAY });
  assert.ok(!r.ok);
  if (!r.ok) for (const p of r.problems) assert.ok(!/000000026|999999998|2099/.test(p.message));
});

check("V10 israelToday is a YYYY-MM-DD date in Asia/Jerusalem (22:30 UTC is already tomorrow there)", () => {
  assert.equal(israelToday(new Date("2026-11-20T22:30:00Z")), "2026-11-21");
  assert.equal(israelToday(new Date("2026-11-20T10:00:00Z")), "2026-11-20");
});

// ---------------------------------------------------------------- statement
check("S1 canonical statement: versioned, raw stored values, fixed order, both dates kept apart, every acknowledgement", () => {
  const lines = canonicalKindTransitionStatement(KIND_TRANSITION_VECTOR.fields).split("\n");
  assert.equal(lines[0], `statement=${KIND_TRANSITION_STATEMENT_VERSION}`);
  assert.ok(lines.includes("legalName=ישראל ישראלי") && lines.includes(`taxId=${TAX}`) && lines.includes(`vatNumber=${TAX}`));
  assert.ok(lines.includes("statusEffectiveDate=2026-11-01"));
  assert.ok(lines.includes("from=EXEMPT_DEALER") && lines.includes("to=AUTHORIZED_DEALER"));
  assert.equal(lines.filter((l) => l.startsWith("ack=")).length, KIND_TRANSITION_ACKNOWLEDGEMENTS.length);
});

check("S2 the digest equals the vector the migration computes in SQL (evidence check 11, lab K2)", () => {
  assert.equal(kindTransitionStatementSha256(KIND_TRANSITION_VECTOR.fields), KIND_TRANSITION_VECTOR.sha256);
});

check("S3 any material field changes the digest", () => {
  const f = KIND_TRANSITION_VECTOR.fields;
  const h = kindTransitionStatementSha256(f);
  for (const patch of [{ businessId: 8 }, { actorUserId: 12 }, { legalName: "ישראל ישראלו" }, { vatNumber: TAX_OTHER }, { statusEffectiveDate: "2026-11-02" }]) {
    assert.notEqual(kindTransitionStatementSha256({ ...f, ...patch }), h, JSON.stringify(patch));
  }
});

// ---------------------------------------------------------------- outcome mapping
check("O1 every database answer maps to a status and a Hebrew message; unknown → 500 'nothing saved'", () => {
  const cases: [string, number][] = [
    ["TRANSITIONED", 200], ["NOT_ALLOWED", 403], ["NOT_SOLE_USER", 409], ["REAUTH_REQUIRED", 401], ["IDENTITY_INCOMPLETE", 409],
    ["NOT_EXEMPT_DEALER", 409], ["VAT_NUMBER_INVALID", 400], ["VAT_NUMBER_DIFFERS_FROM_TAX_ID", 400], ["EFFECTIVE_DATE_INVALID", 400],
    ["ISSUER_DECLARATION_ACTIVE", 409], ["STATEMENT_STALE", 409], ["SOMETHING_ELSE", 500],
    // the 4a writer's refusals, passed on by the wired function (contract §3)
    ["ISSUER_DECLARATION_NOT_AUTHORIZED_USER", 409], ["ISSUER_DECLARATION_IDENTITY_MISMATCH", 409],
    ["ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT", 409], ["ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE", 409],
    ["ISSUER_DECLARATION_NOT_ALLOWED", 500], ["ISSUER_DECLARATION_REAUTH_REQUIRED", 500], ["ISSUER_DECLARATION_STATEMENT_INVALID", 500],
    ["ISSUER_DECLARATION_VAT_NUMBER_INVALID", 500], ["ISSUER_DECLARATION_NO_LIVE_DECLARATION", 500], ["ISSUER_DECLARATION_UNKNOWN", 500],
  ];
  for (const [db, status] of cases) {
    const o = kindTransitionOutcome(db);
    assert.equal(o.status, status, db);
    assert.match(o.message, /[א-ת]/);
  }
});

check("O2 the declaration answers: their own code, a Hebrew text that says nothing was saved, never an echoed value", () => {
  for (const code of Object.keys(KIND_TRANSITION_DECLARATION_MESSAGES)) {
    const o = kindTransitionOutcome(code);
    assert.equal(o.code, code);
    assert.equal(o.message, KIND_TRANSITION_DECLARATION_MESSAGES[code as keyof typeof KIND_TRANSITION_DECLARATION_MESSAGES]);
    assert.match(o.message, /לא נשמר שום שינוי/);
    assert.doesNotMatch(o.message, /d{5,}/);
  }
  assert.match(kindTransitionOutcome("ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE").message, /בעוד כמה דקות/);
  assert.match(kindTransitionOutcome("ISSUER_DECLARATION_IDENTITY_MISMATCH").message, /תמיכה/);
  // no text offers to edit the legal name or the id number
  for (const m of Object.values(KIND_TRANSITION_DECLARATION_MESSAGES)) assert.doesNotMatch(m, /לשנות|לערוך|לתקן/);
  // unreachable writer answers keep the generic 500 text and their code is not exposed
  const u = kindTransitionOutcome("ISSUER_DECLARATION_NO_LIVE_DECLARATION");
  assert.deepEqual([u.status, u.code], [500, "UNKNOWN"]);
});

console.log(`kind-transition: ${checks} checks passed`);
