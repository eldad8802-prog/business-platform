/**
 * Document supplier linking, milestone 1 — the issuer reading and the own-business guard, through the REAL
 * extraction chain (cleanOCRText → parseDocumentStructure → extractDocumentEntities). Synthetic text only.
 *
 * NO database and NO network.
 *
 * Run: npx tsx lib/services/documents/issuer/issuer-reading.test.ts
 */
import assert from "node:assert/strict";

import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { cleanOCRText } from "@/lib/services/documents/text-cleaner.service";
import { parseDocumentStructure } from "@/lib/services/documents/document-structure.service";
import { extractDocumentEntities } from "@/lib/services/documents/entities/entity-extraction.service";
import {
  buildOwnBusinessIdentity,
  isOwnName,
  nameKey,
  readIssuer,
  type OwnBusinessIdentity,
} from "./issuer-reading";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`OK: ${label}`);
}

/** A valid Israeli id from 8 digits (computes the check digit). */
function validId(eight: string): string {
  for (let d = 0; d <= 9; d += 1) {
    const v = authoritativeTaxId(`${eight}${d}`);
    if (v) return v;
  }
  throw new Error("no check digit");
}
/** Same 8 digits, a WRONG check digit (an OCR error on the last digit). */
function invalidId(eight: string): string {
  const good = validId(eight);
  const last = (Number(good[8]) + 1) % 10;
  return `${eight}${last}`;
}

const OWN_ID = validId("51600000");
const ALPHA_ID = validId("51234567");
const BETA_ID = validId("03456789");
const GAMMA_ID = validId("51888888");

const OWN: OwnBusinessIdentity = buildOwnBusinessIdentity({
  businessName: "נגריית הדוגמה",
  legalName: 'נגריית הדוגמה בע"מ',
  taxId: OWN_ID,
});

function read(lines: string[], own: OwnBusinessIdentity | null) {
  const text = cleanOCRText(lines.join("\n"));
  const structure = parseDocumentStructure(text);
  return extractDocumentEntities(text, structure, own);
}

const A = [
  'אלפא ציוד משרדי בע"מ',
  `ח.פ ${ALPHA_ID}`,
  "רחוב הברזל 12 תל אביב",
  "חשבונית מס 1042",
  "תאריך 22/10/2026",
  `לכבוד: נגריית הדוגמה בע"מ ח.פ ${OWN_ID}`,
  "נייר A4 קרטון 5 חבילות 850.00",
  'סה"כ לתשלום 1,000.00',
];
const B = [
  'נגריית הדוגמה בע"מ',
  `ח.פ ${OWN_ID}`,
  "חשבונית מס 2201",
  "תאריך 22/10/2026",
  "לכבוד: משפחת כהן",
  "עבודות נגרות 4,000.00",
  'סה"כ לתשלום 4,680.00',
];
const C = [
  "לכבוד",
  `נגריית הדוגמה בע"מ ח.פ ${OWN_ID}`,
  "חשבונית מס 77",
  "בטא שירותי דפוס",
  `עוסק מורשה ${BETA_ID}`,
  "הדפסת כרטיסי ביקור 300.00",
  'סה"כ 351.00',
];

check("ids used by the fixtures carry a valid check digit, the OCR-error one does not", () => {
  for (const id of [OWN_ID, ALPHA_ID, BETA_ID, GAMMA_ID]) assert.ok(authoritativeTaxId(id));
  assert.equal(authoritativeTaxId(invalidId("51234567")), null);
});

check("flag OFF (no own identity): the extraction is exactly as before and no issuer reading is made", () => {
  for (const doc of [A, B, C]) {
    const before = read(doc, null);
    assert.equal(before.issuer, null);
  }
});

check("A — supplier invoice, the business in the 'לכבוד' block: vendor is the supplier, issuer is its id", () => {
  const r = read(A, OWN);
  assert.ok(r.entities.vendor.name && !isOwnName(OWN, r.entities.vendor.name), `vendor=${r.entities.vendor.name}`);
  assert.equal(r.issuer?.check, "OK");
  assert.equal(r.issuer?.taxId, ALPHA_ID);
  assert.equal(r.issuer?.taxIdValid, true);
  assert.equal(r.issuer?.ownBusinessExcluded, true);
});

check("B — a document the business ISSUED: the business is never the vendor; OWN_BUSINESS_ONLY, no id", () => {
  const off = read(B, null);
  const on = read(B, OWN);
  assert.ok(off.entities.vendor.name && isOwnName(OWN, off.entities.vendor.name), "precondition: today it picks the business");
  assert.ok(!on.entities.vendor.name || !isOwnName(OWN, on.entities.vendor.name), `vendor=${on.entities.vendor.name}`);
  assert.equal(on.entities.vendor.needsReview, true);
  assert.equal(on.issuer?.check, "OWN_BUSINESS_ONLY");
  assert.equal(on.issuer?.taxId, null);
  assert.equal(on.issuer?.ownBusinessExcluded, true);
});

check("C — the business block printed first: vendor is not the business; issuer is the supplier's id", () => {
  const off = read(C, null);
  const on = read(C, OWN);
  assert.ok(off.entities.vendor.name && isOwnName(OWN, off.entities.vendor.name), "precondition: today it picks the business");
  assert.ok(!on.entities.vendor.name || !isOwnName(OWN, on.entities.vendor.name), `vendor=${on.entities.vendor.name}`);
  assert.equal(on.entities.vendor.needsReview, true, "own details excluded ⇒ never presented as certain");
  assert.equal(on.issuer?.check, "OK");
  assert.equal(on.issuer?.taxId, BETA_ID);
});

check("an OCR error in the supplier's id: TAX_ID_INVALID, kept as read, never OK", () => {
  const bad = invalidId("51234567");
  const r = read(A.map((l) => l.replace(ALPHA_ID, bad)), OWN);
  assert.equal(r.issuer?.check, "TAX_ID_INVALID");
  assert.equal(r.issuer?.taxId, bad);
  assert.equal(r.issuer?.taxIdValid, false);
});

check("an OCR error in the business's OWN id: it is not recognised as own, and it is invalid — still never OK", () => {
  const ownBad = invalidId("51600000");
  const r = read(B.map((l) => l.replace(OWN_ID, ownBad)), OWN);
  assert.notEqual(r.issuer?.check, "OK");
});

check("no id on the document: NO_TAX_ID", () => {
  const r = read(["חנות הפינה", "קבלה 5", 'סה"כ 20.00'], OWN);
  assert.equal(r.issuer?.check, "NO_TAX_ID");
  assert.equal(r.issuer?.taxId, null);
});

check("two different valid ids, neither on the vendor line: CONFLICTING_TAX_IDS, no id chosen", () => {
  const reading = readIssuer({
    businessIds: [
      { value: ALPHA_ID, type: "IL_COMPANY", confidence: 0.9, source: "business_id", line: `ח.פ ${ALPHA_ID}` },
      { value: GAMMA_ID, type: "IL_COMPANY", confidence: 0.9, source: "business_id", line: `ח.פ ${GAMMA_ID}` },
    ],
    vendor: { name: "x", businessId: null, confidence: 0.5, source: "header", signals: [], needsReview: true, reason: "" },
    headerLines: [],
    own: OWN,
    ownNameExcluded: false,
  });
  assert.equal(reading.check, "CONFLICTING_TAX_IDS");
  assert.equal(reading.taxId, null);
});

check("the vendor-line id wins over another id on the page (VENDOR_LINE)", () => {
  const reading = readIssuer({
    businessIds: [
      { value: ALPHA_ID, type: "IL_COMPANY", confidence: 0.9, source: "business_id", line: `אלפא ח.פ ${ALPHA_ID}` },
      { value: GAMMA_ID, type: "IL_COMPANY", confidence: 0.9, source: "business_id", line: `ח.פ ${GAMMA_ID}` },
    ],
    vendor: { name: "אלפא", businessId: null, confidence: 0.9, source: "business_id", signals: [`business_id=${ALPHA_ID}`], needsReview: false, reason: "" },
    headerLines: [],
    own: OWN,
    ownNameExcluded: false,
  });
  assert.equal(reading.check, "OK");
  assert.equal(reading.taxId, ALPHA_ID);
  assert.equal(reading.taxIdSource, "VENDOR_LINE");
});

check("own name: exact key, and a multi-word own name inside a longer line; a one-word own name only exactly", () => {
  assert.ok(isOwnName(OWN, 'נגריית הדוגמה בע"מ'));
  assert.ok(isOwnName(OWN, "נגריית הדוגמה"));
  assert.ok(!isOwnName(OWN, "אלפא ציוד משרדי"));
  const one = buildOwnBusinessIdentity({ businessName: "דוד" });
  assert.ok(isOwnName(one, "דוד"));
  assert.ok(!isOwnName(one, "דוד מוצרי חשמל"), "a one-word own name must not swallow a supplier that starts with it");
});

check("identical and alternate names share a key (suffixes, spacing); a different name does not", () => {
  assert.equal(nameKey('אלפא ציוד משרדי בע"מ'), nameKey("אלפא ציוד משרדי"));
  assert.equal(nameKey("  אלפא   ציוד משרדי "), nameKey("אלפא ציוד משרדי"));
  assert.notEqual(nameKey("אלפא ציוד משרדי"), nameKey("בטא שירותי דפוס"));
  assert.equal(nameKey(""), null);
});

check("own identity: an 8-digit id is padded; an own id without a valid check digit is still own", () => {
  const eight = buildOwnBusinessIdentity({ taxId: OWN_ID.replace(/^0/, "") });
  assert.ok(eight.taxIds.includes(OWN_ID.padStart(9, "0")));
  const typo = buildOwnBusinessIdentity({ taxId: "123456789" });
  assert.ok(typo.taxIds.includes("123456789"));
});

console.log(`\nissuer reading: ${passed} passed ✔`);
