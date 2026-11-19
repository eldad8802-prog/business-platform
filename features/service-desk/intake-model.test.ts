/**
 * Run: npx tsx features/service-desk/intake-model.test.ts
 *
 * The intake screen's pure logic and the server's `allowed` (what the screen may offer). Owner decision 2026-11-11: no
 * customer signature — the owner confirms the documented intake; the slip follows the confirmation.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { intakeAllowed } from "@/lib/services/service-desk/intake.service";

import type { IntakeView } from "./intake-client";
import { PHOTO_MAX_EDGE, confirmBlocker, currentSection, downscaleTarget, historyLine } from "./intake-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const NONE = { recordData: false, addPhoto: false, confirm: false, createSlip: false };
const intake = { conditionNote: "x", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, signed: false, signedAt: null, termsVersion: null, hasSignature: false, hasSlip: false };
const v = (o: Partial<IntakeView> = {}): IntakeView => ({
  intake, terms: null, activeTerms: { termsVersion: null, statutoryVersion: null, approved: false },
  photos: [], history: [], confirmation: null, case: { caseNumber: 7, kind: "IN_SHOP", status: "OPEN", version: 4 },
  allowed: { ...NONE, recordData: true, addPhoto: true, confirm: true }, ...o,
});

// sections
ok("M1 nothing documented → the data section first", currentSection(v({ intake: null })) === "data");
ok("M2 documented, not confirmed → the confirmation section", currentSection(v()) === "confirm");
ok("M3 confirmed → done", currentSection(v({ confirmation: { at: "2026-11-11T08:00:00.000Z", byUserId: 3, byName: "דנה" } })) === "done");

// the confirmation blocker
ok("B1 allowed to confirm → no blocker", confirmBlocker(v()) === null);
ok("B2 data not documented → document first (accessories may be recorded as 'none handed over')",
  (confirmBlocker(v({ intake: { ...intake, accessoriesRecorded: false }, allowed: NONE })) ?? "").includes("לא נמסרו אביזרים"));
ok("B3 already confirmed → says so", (confirmBlocker(v({ confirmation: { at: "x", byUserId: 1, byName: null }, allowed: NONE })) ?? "").includes("כבר אושרה"));
ok("B4 no blocker text mentions a signature or legal terms", ![v({ intake: null, allowed: NONE }), v({ allowed: NONE })].some((x) => /חתימ|תנאי/.test(confirmBlocker(x) ?? "")));

// history, downscale
ok("H1 history lines in Hebrew; a data save reads as an update", historyLine("PHOTO_ADDED") === "נוספה תמונה" && historyLine("SLIP_STORED").includes("PDF") && historyLine(null) === "עודכנו פרטי הקליטה");
const big = downscaleTarget(4032, 3024);
ok("D1 a 12 MP photo leaves at most PHOTO_MAX_EDGE on its long edge, keeping its ratio; a small one is untouched",
  big.width === PHOTO_MAX_EDGE && big.height === 1200 && JSON.stringify(downscaleTarget(800, 600)) === '{"width":800,"height":600}' && downscaleTarget(0, 10).width === 0);

// the server's allowed
const A = (o: Partial<Parameters<typeof intakeAllowed>[0]> = {}) =>
  intakeAllowed({ kind: "IN_SHOP", status: "OPEN", recorded: true, photoCount: 0, confirmed: false, hasSlip: false, ...o });
ok("A1 an open IN_SHOP intake, documented → data, photos and the owner's confirmation; no slip yet",
  JSON.stringify(A()) === JSON.stringify({ recordData: true, addPhoto: true, confirm: true, createSlip: false }));
ok("A2 not documented → no confirmation", !A({ recorded: false }).confirm && A({ recorded: false }).recordData);
ok("A3 ten photos → no more photos", !A({ photoCount: 10 }).addPhoto && A({ photoCount: 9 }).addPhoto);
ok("A4 confirmed → nothing changes any more; the slip once", JSON.stringify(A({ confirmed: true, status: "CHECKED_IN" })) === JSON.stringify({ ...NONE, createSlip: true })
  && !A({ confirmed: true, status: "CHECKED_IN", hasSlip: true }).createSlip);
ok("A5 a FIELD case, or an IN_SHOP case past check-in without a confirmation → no intake action; SCHEDULED is open",
  JSON.stringify(A({ kind: "FIELD" })) === JSON.stringify(NONE) && JSON.stringify(A({ status: "CHECKED_IN" })) === JSON.stringify(NONE) && A({ status: "SCHEDULED" }).recordData);
ok("A6 no allowed action names a signature or terms (owner decision 2026-11-11)", !/sign|terms/i.test(Object.keys(A()).join(",")));

// the screen and the closed routes
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
ok("S1 the intake screen has no signature pad, no canvas and no terms step",
  !/<canvas|SignaturePad|signIntake|presentTerms|חתימת הלקוח/.test(src("features/service-desk/intake-screen.tsx")));
ok("S2 the former signature and terms routes answer ACTION_NOT_IN_SCOPE and call no service",
  ["app/api/service-desk/cases/[id]/intake/sign/route.ts", "app/api/service-desk/cases/[id]/intake/terms/route.ts"].every((r) => {
    const t = src(r);
    return /ACTION_NOT_IN_SCOPE/.test(t) && /serviceDeskRoute\(req, "write"/.test(t) && !/signIntake|presentTerms|intake\.service/.test(t);
  }));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
