/**
 * Run: npx tsx features/service-desk/intake-model.test.ts
 *
 * 1.3b-C — the intake screen's pure logic and the server's `allowed` (what the screen may offer): sections, the signing
 * blocker wording (no signature without legally approved terms), history lines, photo downscale, a drawn signature, and
 * intakeAllowed over every combination that matters.
 */
import { intakeAllowed } from "@/lib/services/service-desk/intake.service";

import type { IntakeView } from "./intake-client";
import { PHOTO_MAX_EDGE, currentSection, downscaleTarget, historyLine, signBlocker, signatureLooksDrawn } from "./intake-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const NONE = { recordData: false, addPhoto: false, presentTerms: false, sign: false, createSlip: false };
const v = (o: Partial<IntakeView> = {}): IntakeView => ({
  intake: { conditionNote: "x", accessoriesNote: "y", conditionRecorded: true, accessoriesRecorded: true, signed: false, signedAt: null, termsVersion: null, hasSignature: false, hasSlip: false },
  terms: { presentedAt: "2026-11-11T08:00:00.000Z", termsVersion: 2, statutoryVersion: 1, termsSha256: "a".repeat(64), statutorySha256: "b".repeat(64), termsBody: "t", statutoryBody: "s" },
  activeTerms: { termsVersion: 2, statutoryVersion: 1, approved: true },
  photos: [], history: [], case: { caseNumber: 7, kind: "IN_SHOP", status: "OPEN", version: 4 },
  allowed: { ...NONE, recordData: true, addPhoto: true, sign: true }, ...o,
});

// sections
ok("M1 nothing recorded → the data section first", currentSection(v({ intake: null })) === "data");
ok("M2 data recorded, no terms → the terms section", currentSection(v({ terms: null })) === "terms");
ok("M3 data + terms → the signature section; signed → done", currentSection(v()) === "sign" && currentSection(v({ intake: { ...v().intake!, signed: true } })) === "done");

// the signing blocker
ok("B1 allowed to sign → no blocker", signBlocker(v()) === null);
ok("B2 no presented terms and no approved texts → the legal-approval wording (owner rule)", (signBlocker(v({ terms: null, activeTerms: { termsVersion: 1, statutoryVersion: 1, approved: false }, allowed: NONE })) ?? "").includes("אושר משפטית"));
ok("B3 approved texts but data not recorded → record first", (signBlocker(v({ terms: null, intake: { ...v().intake!, conditionRecorded: false }, allowed: NONE })) ?? "").includes("מצב המכשיר"));
ok("B4 data recorded, approved, not presented → present the terms first", (signBlocker(v({ terms: null, allowed: NONE })) ?? "").includes("הציגו"));

// history, downscale, the drawn signature
ok("H1 history lines in Hebrew for every intake step; a data save reads as an update",
  historyLine("TERMS_PRESENTED").includes("התנאים") && historyLine("SIGNED") === "הלקוח חתם" && historyLine("SLIP_STORED").includes("PDF") && historyLine(null) === "עודכנו פרטי הקליטה");
const big = downscaleTarget(4032, 3024);
ok("D1 a 12 MP photo leaves at most PHOTO_MAX_EDGE on its long edge, keeping its ratio; a small one is untouched",
  big.width === PHOTO_MAX_EDGE && big.height === 1200 && JSON.stringify(downscaleTarget(800, 600)) === '{"width":800,"height":600}' && downscaleTarget(0, 10).width === 0);
const line = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: 50 + (i % 3) * 5 }));
ok("S1 a real stroke is a signature; a tap or a dot is not", signatureLooksDrawn([line]) && !signatureLooksDrawn([[{ x: 1, y: 1 }]]) && !signatureLooksDrawn([Array.from({ length: 20 }, () => ({ x: 5, y: 5 }))]));

// the server's allowed
const A = (o: Partial<Parameters<typeof intakeAllowed>[0]> = {}) =>
  intakeAllowed({ kind: "IN_SHOP", status: "OPEN", signed: false, recorded: true, photoCount: 0, presented: true, approved: true, hasSlip: false, ...o });
ok("A1 an open IN_SHOP intake, recorded and presented → data, photos and signing; not present again, no slip yet",
  JSON.stringify(A()) === JSON.stringify({ recordData: true, addPhoto: true, presentTerms: false, sign: true, createSlip: false }));
ok("A2 not presented + approved → present allowed, signing not", A({ presented: false }).presentTerms && !A({ presented: false }).sign);
ok("A3 not presented + NOT approved → neither present nor sign (no signature without approved terms)", !A({ presented: false, approved: false }).presentTerms && !A({ presented: false, approved: false }).sign);
ok("A4 not recorded → no signing", !A({ recorded: false }).sign);
ok("A5 ten photos → no more photos", !A({ photoCount: 10 }).addPhoto && A({ photoCount: 9 }).addPhoto);
ok("A6 signed → nothing changes any more; the slip once", JSON.stringify(A({ signed: true })) === JSON.stringify({ ...NONE, createSlip: true }) && !A({ signed: true, hasSlip: true }).createSlip);
ok("A7 a FIELD case, or an IN_SHOP case past check-in → no intake action",
  JSON.stringify(A({ kind: "FIELD" })) === JSON.stringify(NONE) && JSON.stringify(A({ status: "CHECKED_IN" })) === JSON.stringify(NONE) && A({ status: "SCHEDULED" }).recordData);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
