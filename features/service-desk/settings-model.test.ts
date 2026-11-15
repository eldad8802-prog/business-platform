/**
 * Service Desk UI 1.3a — the settings form model and the refusal wording. Pure. Run:
 *   npx tsx features/service-desk/settings-model.test.ts
 */
import { ServiceDeskApiError, type ServiceSettings } from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { bodyFrom, formFrom, hasProblems, isDirty, validate, warrantySummary, type SettingsForm } from "./settings-model";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}`, extra ?? "");
  }
}

const empty: ServiceSettings = { version: null, defaultStaffMemberId: null, warrantyTemplate: null, activeTermsVersionId: null, activeStatutoryNoticeVersionId: null };
const saved: ServiceSettings = {
  version: 3, defaultStaffMemberId: 7, warrantyTemplate: { value: 6, unit: "MONTHS", scope: "חלקים ועבודה", exclusions: null },
  activeTermsVersionId: null, activeStatutoryNoticeVersionId: null,
};
const withWarranty = (over: Partial<SettingsForm>): SettingsForm => ({ ...formFrom(empty), warrantyOn: true, value: "12", unit: "MONTHS", scope: "תיקון", ...over });

// ---- form from the server --------------------------------------------------------------------------------------
const f0 = formFrom(empty);
ok("M1 a new business: the owner handles cases, no warranty (no default, מ3)", f0.staffId === "" && f0.warrantyOn === false && f0.value === "");
const f1 = formFrom(saved);
ok("M2 saved settings fill the form", f1.staffId === "7" && f1.warrantyOn && f1.value === "6" && f1.unit === "MONTHS" && f1.scope === "חלקים ועבודה" && f1.exclusions === "");

// ---- validation, mirroring the server's limits -----------------------------------------------------------------
ok("V1 no warranty → nothing to validate", !hasProblems(validate(f0)));
ok("V2 a valid warranty passes", !hasProblems(validate(withWarranty({}))));
ok("V3 value 0, negative, decimal or text → refused", ["0", "-3", "1.5", "abc", ""].every((value) => !!validate(withWarranty({ value })).value));
ok("V4 120 months passes, 121 refused", !validate(withWarranty({ value: "120" })).value && !!validate(withWarranty({ value: "121" })).value);
ok("V5 3650 days passes, 3651 refused", !validate(withWarranty({ unit: "DAYS", value: "3650" })).value && !!validate(withWarranty({ unit: "DAYS", value: "3651" })).value);
ok("V6 a warranty needs a scope (whitespace is not a scope)", !!validate(withWarranty({ scope: "   " })).scope);
ok("V7 scope / exclusions over 2000 characters refused; 2000 passes",
  !!validate(withWarranty({ scope: "א".repeat(2001) })).scope && !validate(withWarranty({ scope: "א".repeat(2000) })).scope && !!validate(withWarranty({ exclusions: "ב".repeat(2001) })).exclusions);
ok("V8 characters, not UTF-16 units, are counted (emoji)", !validate(withWarranty({ scope: "🔧".repeat(2000) })).scope);

// ---- the request body ------------------------------------------------------------------------------------------
const b0 = bodyFrom(f0, null);
ok("B1 first save: expectedVersion null, owner (null staff), no template", b0.expectedVersion === null && b0.defaultStaffMemberId === null && b0.warrantyTemplate === null);
const b1 = bodyFrom(withWarranty({ staffId: "9", value: " 24 ", scope: "  כיסוי  ", exclusions: "   " }), 3);
ok("B2 trimmed values, staff as a number, empty exclusions → null, the loaded version",
  b1.expectedVersion === 3 && b1.defaultStaffMemberId === 9 && b1.warrantyTemplate?.value === 24 && b1.warrantyTemplate.scope === "כיסוי" && b1.warrantyTemplate.exclusions === null);
ok("B3 the template's key order matches the server's view (for the dirty check)", JSON.stringify(Object.keys(b1.warrantyTemplate ?? {})) === JSON.stringify(["value", "unit", "scope", "exclusions"]));

// ---- dirty -----------------------------------------------------------------------------------------------------
ok("D1 the loaded form is not dirty", !isDirty(formFrom(saved), saved) && !isDirty(formFrom(empty), empty));
ok("D2 whitespace alone is not a change", !isDirty({ ...formFrom(saved), scope: "  חלקים ועבודה  " }, saved));
ok("D3 another technician, the owner, or a changed warranty is a change",
  isDirty({ ...formFrom(saved), staffId: "8" }, saved) && isDirty({ ...formFrom(saved), staffId: "" }, saved) && isDirty({ ...formFrom(saved), value: "7" }, saved) && isDirty({ ...formFrom(saved), warrantyOn: false }, saved));

ok("S1 summary wording", warrantySummary(1, "MONTHS") === "חודש אחד" && warrantySummary(12, "MONTHS") === "12 חודשים" && warrantySummary(1, "DAYS") === "יום אחד" && warrantySummary(30, "DAYS") === "30 ימים");

// ---- refusal wording -------------------------------------------------------------------------------------------
const err = (status: number | null, code: string | null, details: Record<string, unknown> | null = null) => errorView(new ServiceDeskApiError(status, code, details));
ok("E1 VERSION_CONFLICT asks for a reload", err(409, "VERSION_CONFLICT").reload === true && err(409, "VERSION_CONFLICT").text.includes("רענן"));
ok("E2 an inactive technician (server check) asks to pick again and reloads the list",
  err(422, "SERVER_CHECK_FAILED", { check: "STAFF_BELONGS_TO_BUSINESS" }).reload === true && err(422, "SERVER_CHECK_FAILED", { check: "STAFF_BELONGS_TO_BUSINESS" }).text.includes("לא פעיל"));
ok("E3 NO_CHANGE and the table's codes read in Hebrew", err(422, "REFUSED", { violations: ["NO_CHANGE"] }).text.includes("לא שינית") && err(422, "REFUSED", { violations: ["QA_INCOMPLETE"] }).text.includes("רשימת הבדיקות"));
ok("E4 an unknown refusal or internal code never shows the code itself", !err(422, "REFUSED", { violations: ["INVALID_TRANSITION"] }).text.includes("INVALID") && !err(409, "CONFLICT").text.includes("CONFLICT"));
ok("E5 the journal missing (P4) says nothing was saved", err(422, "NOT_AVAILABLE_UNTIL_AUDIT").text.includes("לא נשמר"));
ok("E6 read-only, deleting, offline, 5xx, 401 and 429 have their own lines",
  err(403, "READ_ONLY").text.includes("צפייה") && err(409, "BUSINESS_DELETING").text.includes("מחיקה") && err(null, null).text.includes("חיבור")
    && err(500, "INTERNAL").text.includes("לא נשמר") && err(401, null).text.includes("להתחבר") && err(429, null).text.includes("יותר מדי"));
ok("E7 INVALID_INPUT carries the field the server named", err(400, "INVALID_INPUT", { field: "warrantyTemplate" }).field === "warrantyTemplate");
ok("E8 a non-API error falls back to a generic line", errorView(new Error("boom")).text.length > 0 && !errorView(new Error("boom")).text.includes("boom"));

console.log(`\nservice-desk settings model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
