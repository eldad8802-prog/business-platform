/**
 * Run: npx tsx lib/services/service-desk/intake-core.test.ts
 *
 * 1.3b intake signature path — the pure decisions: who may present terms, add a photo, sign; the image checks by bytes;
 * no signature without an approved terms snapshot (owner rule 2026-11-10); determinism and no I/O in the core.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { SERVICE_CASE_KINDS, SERVICE_CASE_STATUSES } from "./contracts";
import {
  SIGNATURE_MAX_BYTES,
  evaluateAddPhoto,
  evaluatePresentTerms,
  evaluateSign,
  pngDimensions,
  sniffImage,
  type IntakeFacts,
  type TextFact,
} from "./intake.core";
import { INTAKE_PHOTO_MAX_BYTES, INTAKE_PHOTOS_PER_CASE } from "./storage/service-storage-keys";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const refusedWith = (d: { ok: boolean; violations?: string[] }, code: string) => !d.ok && (d.violations ?? []).includes(code);

/** A PNG header with an IHDR of the given size, padded to `bytes` (the core reads only the header). */
function png(width: number, height: number, bytes = 2000): Uint8Array {
  const b = new Uint8Array(Math.max(bytes, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width); v.setUint32(20, height);
  return b;
}
const jpeg = (n = 5000) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const webp = (n = 5000) => { const b = new Uint8Array(n); b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]); return b; };

const facts = (o: Partial<IntakeFacts> = {}): IntakeFacts => ({
  kind: "IN_SHOP", status: "OPEN",
  intake: { conditionRecorded: true, accessoriesRecorded: true, signed: false },
  termsSnapshot: { termsVersion: 3, statutoryVersion: 1 },
  photoCount: 0, ...o,
});
const T = (o: Partial<NonNullable<TextFact>> = {}): TextFact => ({ id: 11, kind: "TERMS", version: 3, legalStatus: "LEGALLY_APPROVED", bodySha256: "a".repeat(64), ...o });
const S = (o: Partial<NonNullable<TextFact>> = {}): TextFact => ({ id: 12, kind: "STATUTORY_NOTICE", version: 1, legalStatus: "LEGALLY_APPROVED", bodySha256: "b".repeat(64), ...o });
const SIG = png(600, 200);

// ── 1. image checks by bytes ──
ok("I1 PNG / JPEG / WebP are recognised by their first bytes", sniffImage(png(10, 10)) === "image/png" && sniffImage(jpeg()) === "image/jpeg" && sniffImage(webp()) === "image/webp");
ok("I2 text, PDF, GIF and empty bytes are not images", sniffImage(Buffer.from("hello world")) === null && sniffImage(Buffer.from("%PDF-1.7 ....")) === null
  && sniffImage(Buffer.from("GIF89a......")) === null && sniffImage(new Uint8Array(0)) === null);
ok("I3 PNG width/height come from IHDR; a non-PNG has none", JSON.stringify(pngDimensions(png(640, 180))) === '{"width":640,"height":180}' && pngDimensions(jpeg()) === null);

// ── 2. present terms ──
const pt = evaluatePresentTerms(facts({ termsSnapshot: null }), T(), S());
ok("P1 approved TERMS + STATUTORY_NOTICE → frozen with their ids, versions and hashes",
  pt.ok && pt.termsVersionId === 11 && pt.statutoryVersionId === 12 && pt.termsSha256 === "a".repeat(64) && pt.statutorySha256 === "b".repeat(64) && pt.termsVersion === 3);
ok("P2 a DRAFT terms or a DRAFT notice → TERMS_NOT_APPROVED (never shown to a customer as approved)",
  refusedWith(evaluatePresentTerms(facts({ termsSnapshot: null }), T({ legalStatus: "DRAFT" }), S()), "TERMS_NOT_APPROVED")
    && refusedWith(evaluatePresentTerms(facts({ termsSnapshot: null }), T(), S({ legalStatus: "DRAFT" })), "TERMS_NOT_APPROVED"));
ok("P3 no active terms / notice, or the wrong kind in a slot → TERMS_NOT_CONFIGURED",
  refusedWith(evaluatePresentTerms(facts({ termsSnapshot: null }), null, S()), "TERMS_NOT_CONFIGURED")
    && refusedWith(evaluatePresentTerms(facts({ termsSnapshot: null }), T(), null), "TERMS_NOT_CONFIGURED")
    && refusedWith(evaluatePresentTerms(facts({ termsSnapshot: null }), S(), T()), "TERMS_NOT_CONFIGURED"));
ok("P4 once per case: a second presentation → TERMS_ALREADY_PRESENTED", refusedWith(evaluatePresentTerms(facts(), T(), S()), "TERMS_ALREADY_PRESENTED"));

// ── 3. the shared step rules, over every kind × status ──
let stepRight = true;
for (const kind of SERVICE_CASE_KINDS) for (const status of SERVICE_CASE_STATUSES) {
  const f = facts({ kind, status, termsSnapshot: null });
  const allowed = kind === "IN_SHOP" && (status === "OPEN" || status === "SCHEDULED");
  const p = evaluatePresentTerms(f, T(), S());
  const ph = evaluateAddPhoto(f, { declaredMime: "image/jpeg", bytes: jpeg() });
  const sg = evaluateSign({ ...f, termsSnapshot: { termsVersion: 3, statutoryVersion: 1 } }, SIG);
  if (p.ok !== allowed || ph.ok !== allowed || sg.ok !== allowed) stepRight = false;
  if (!allowed && kind !== "IN_SHOP" && !(refusedWith(p, "INTAKE_ONLY_IN_SHOP") && refusedWith(ph, "INTAKE_ONLY_IN_SHOP") && refusedWith(sg, "INTAKE_ONLY_IN_SHOP"))) stepRight = false;
  if (!allowed && kind === "IN_SHOP" && !(refusedWith(p, "INTAKE_ONLY_BEFORE_CHECK_IN") && refusedWith(sg, "INTAKE_ONLY_BEFORE_CHECK_IN"))) stepRight = false;
}
ok("S1 every step is allowed only for IN_SHOP in OPEN / SCHEDULED (3 kinds × every status), with its reason otherwise", stepRight);
const signedFacts = facts({ intake: { conditionRecorded: true, accessoriesRecorded: true, signed: true } });
ok("S2 after the signature nothing changes: terms, photos and a second signature → INTAKE_SIGNED",
  refusedWith(evaluatePresentTerms({ ...signedFacts, termsSnapshot: null }, T(), S()), "INTAKE_SIGNED")
    && refusedWith(evaluateAddPhoto(signedFacts, { declaredMime: "image/jpeg", bytes: jpeg() }), "INTAKE_SIGNED")
    && refusedWith(evaluateSign(signedFacts, SIG), "INTAKE_SIGNED"));

// ── 4. photos ──
const ph = evaluateAddPhoto(facts({ photoCount: 2 }), { declaredMime: "image/webp", bytes: webp(7000) });
ok("F1 a WebP whose bytes match → accepted, its size, photo number 3", ph.ok && ph.mimeType === "image/webp" && ph.byteSize === 7000 && ph.photoNumber === 3);
ok("F2 declared type ≠ bytes, or not an image, or an unknown declared type → PHOTO_TYPE",
  refusedWith(evaluateAddPhoto(facts(), { declaredMime: "image/png", bytes: jpeg() }), "PHOTO_TYPE")
    && refusedWith(evaluateAddPhoto(facts(), { declaredMime: "image/jpeg", bytes: Buffer.from("not an image at all") }), "PHOTO_TYPE")
    && refusedWith(evaluateAddPhoto(facts(), { declaredMime: "image/gif", bytes: jpeg() }), "PHOTO_TYPE"));
ok(`F3 above ${INTAKE_PHOTO_MAX_BYTES} bytes → PHOTO_TOO_LARGE`, refusedWith(evaluateAddPhoto(facts(), { declaredMime: "image/jpeg", bytes: jpeg(INTAKE_PHOTO_MAX_BYTES + 1) }), "PHOTO_TOO_LARGE"));
ok(`F4 the ${INTAKE_PHOTOS_PER_CASE + 1}th photo → PHOTO_LIMIT; the ${INTAKE_PHOTOS_PER_CASE}th passes`,
  refusedWith(evaluateAddPhoto(facts({ photoCount: INTAKE_PHOTOS_PER_CASE }), { declaredMime: "image/jpeg", bytes: jpeg() }), "PHOTO_LIMIT")
    && evaluateAddPhoto(facts({ photoCount: INTAKE_PHOTOS_PER_CASE - 1 }), { declaredMime: "image/jpeg", bytes: jpeg() }).ok);
ok("F5 photos are allowed before the terms are presented (optional, any order before the signature)", evaluateAddPhoto(facts({ termsSnapshot: null }), { declaredMime: "image/jpeg", bytes: jpeg() }).ok);

// ── 5. the signature ──
const sg = evaluateSign(facts(), SIG);
ok("G1 recorded intake + approved snapshot + a plausible PNG → signed, termsVersion label T3-S1", sg.ok && sg.termsVersionLabel === "T3-S1" && sg.width === 600 && sg.height === 200);
ok("G2 owner rule: no terms snapshot → TERMS_NOT_PRESENTED (no signature without approved terms)", refusedWith(evaluateSign(facts({ termsSnapshot: null }), SIG), "TERMS_NOT_PRESENTED"));
ok("G3 no intake row, or condition / accessories not recorded → INTAKE_NOT_RECORDED",
  refusedWith(evaluateSign(facts({ intake: null }), SIG), "INTAKE_NOT_RECORDED")
    && refusedWith(evaluateSign(facts({ intake: { conditionRecorded: false, accessoriesRecorded: true, signed: false } }), SIG), "INTAKE_NOT_RECORDED")
    && refusedWith(evaluateSign(facts({ intake: { conditionRecorded: true, accessoriesRecorded: false, signed: false } }), SIG), "INTAKE_NOT_RECORDED"));
ok("G4 a JPEG, a tiny / huge PNG, too small or too large dimensions → SIGNATURE_INVALID",
  refusedWith(evaluateSign(facts(), jpeg()), "SIGNATURE_INVALID") && refusedWith(evaluateSign(facts(), png(600, 200, 50)), "SIGNATURE_INVALID")
    && refusedWith(evaluateSign(facts(), png(600, 200, SIGNATURE_MAX_BYTES + 1)), "SIGNATURE_INVALID")
    && refusedWith(evaluateSign(facts(), png(50, 200)), "SIGNATURE_INVALID") && refusedWith(evaluateSign(facts(), png(600, 20)), "SIGNATURE_INVALID")
    && refusedWith(evaluateSign(facts(), png(5000, 200)), "SIGNATURE_INVALID"));
ok("G5 every reason is reported together (a FIELD case, unsigned data, no terms, a bad image)", (() => {
  const d = evaluateSign(facts({ kind: "FIELD", intake: null, termsSnapshot: null }), jpeg());
  return !d.ok && ["INTAKE_ONLY_IN_SHOP", "INTAKE_NOT_RECORDED", "TERMS_NOT_PRESENTED", "SIGNATURE_INVALID"].every((c) => d.violations.includes(c as never));
})());

// ── 6. purity ──
const f0 = facts(); const before = JSON.stringify(f0);
const a = JSON.stringify(evaluateSign(f0, SIG)), b = JSON.stringify(evaluateSign(f0, SIG));
ok("D1 same input → same output; the facts are not mutated", a === b && JSON.stringify(f0) === before);
const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/intake.core.ts"), "utf8");
ok("D2 the core imports nothing impure (no prisma, storage, fetch, fs, Date, Math.random)",
  !/from "@prisma|@\/lib\/storage|node:fs|from "fs"|fetch\(|new Date|Date\.now|Math\.random/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
