/**
 * The supplier order PDF is UNCHANGED by the extraction of its builder (purchase-order sheet, owner-approved 2026-11-09).
 * Pure (no DB/network; the clock is fixed by fixtures and TZ).
 *
 * The hashes below were recorded from the ORIGINAL downloadSupplierPurchaseOrderPdf of origin/main cfbbf0ae, by
 * capturing the exact pdfmake document definition it hands to pdfMake.createPdf (functions included by their source,
 * plus the footer evaluated on page 2 of 3). The same capture of today's code must give the same hashes, and the
 * extracted builder must produce that very definition — so the browser download, and a server rendering of the same
 * draft with the same header and date, print the same document.
 *
 * The right-to-left text fix (lib/text/rtl-inline-text: "Dubiz" printed as "zibuD", multi-word Hebrew in reversed word
 * order) changes the document ON PURPOSE, so the hashes are not compared with today's builder any more. They stay as
 * recorded: a verbatim copy of the builder before the fix (supplier-document-before-bidi.fixture.ts) must still give
 * them, and today's builder must equal that copy everywhere except its text nodes, each of which is the same text as
 * direction runs (rtlInlines). Browser download and server rendering still get one and the same definition.
 *
 * Run: npx tsx lib/services/business-documents/po-sheet/supplier-document-unchanged.test.ts
 */
process.env.TZ = "Asia/Jerusalem";

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import pdfMake from "pdfmake/build/pdfmake";

import { rtlInlines } from "@/lib/text/rtl-inline-text";
import { buildSupplierPurchaseOrderDocDefinitionBeforeBidi } from "@/lib/services/business-documents/po-sheet/supplier-document-before-bidi.fixture";
import {
  buildSupplierPurchaseOrderDocDefinition,
  downloadSupplierPurchaseOrderPdf,
  formatSupplierDraftDisplayDate,
  type SupplierPurchaseDraftForDocument,
} from "@/lib/services/inventory/supplier-purchase-document.service";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const canon = (v: unknown): unknown =>
  typeof v === "function"
    ? `fn:${v.toString()}`
    : Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake definitions are untyped
const digest = (def: any) => createHash("sha256").update(JSON.stringify(canon({ ...def, footerAt2of3: def.footer(2, 3) }))).digest("hex");

const TITLE = "מלאי · Dubiz";
const FIXTURES: Record<string, SupplierPurchaseDraftForDocument> = {
  basic: { id: 41, supplierName: "ספק בדיקה", externalOrderId: "A-100", orderDate: "2026-11-03T08:00:00.000Z", lines: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }, { rawName: "מוצר ב", quantity: 2.5, unitType: "KG" }] },
  "no-external-no-names": { id: 7, supplierName: null, externalOrderId: null, createdAt: "2026-10-01T21:30:00.000Z", lines: [{ rawName: null, quantity: 1, unitType: null }] },
  "many-lines-box": { id: 1234, supplierName: 'ספק גדול בע"מ', externalOrderId: "  ", orderDate: "2026-01-15T00:00:00.000Z", lines: [{ rawName: "x1", quantity: 12, unitType: "BOX" }, { rawName: "x2", quantity: 3, unitType: "PACK" }, { rawName: "x3", quantity: 0, unitType: "UNIT" }, { rawName: "x4", quantity: 100, unitType: "LITER" }] },
};
/** Recorded from the original function (origin/main cfbbf0ae) — never updated to make this pass. */
const ORIGINAL: Record<string, string> = {
  basic: "5264ee462f0b6ccfac4609a0acd291802fc214fe49b713d38286a8f336c8e300",
  "no-external-no-names": "d4a0721ccc8c664d0bb4d16dc91541131113d9a19c20cfae3f5d644b3063cf3f",
  "many-lines-box": "682f4c4f3c666ee497876e931d8593979699ed27d820cad2da8e5bea713ca9bb",
};

console.log("the copy of the builder before the right-to-left fix is the original");
for (const [name, draft] of Object.entries(FIXTURES)) {
  ok(`${name}: pre-fix copy = original`, digest(buildSupplierPurchaseOrderDocDefinitionBeforeBidi(draft, { headerTitle: TITLE })) === ORIGINAL[name]);
}

/** Every place where `fixed` differs from `before`: allowed only at a `text` whose fixed value is rtlInlines(before). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake definitions are untyped
function differences(fixed: any, before: any, path: string, out: string[]): string[] {
  if (path.endsWith(".text") && typeof before === "string" && Array.isArray(fixed)) {
    if (!isDeepStrictEqual(fixed, rtlInlines(before.replaceAll(" ", " ")))) out.push(`${path}: not the same text as direction runs`);
    return out;
  }
  if (typeof fixed === "function" || typeof before === "function") {
    if (String(fixed) !== String(before)) out.push(`${path}: function changed`);
    return out;
  }
  if (fixed && before && typeof fixed === "object" && typeof before === "object") {
    const keys = new Set([...Object.keys(fixed), ...Object.keys(before)]);
    for (const k of keys) differences(fixed[k], before[k], `${path}.${k}`, out);
    return out;
  }
  if (fixed !== before) out.push(`${path}: ${JSON.stringify(before)} -> ${JSON.stringify(fixed)}`);
  return out;
}

console.log("the fixed builder differs from the original only in its text nodes, each the same text as direction runs");
for (const [name, draft] of Object.entries(FIXTURES)) {
  for (const displayDate of [undefined, formatSupplierDraftDisplayDate(draft)]) {
    const fixed = buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle: TITLE, displayDate });
    const before = buildSupplierPurchaseOrderDocDefinitionBeforeBidi(draft, { headerTitle: TITLE, displayDate });
    const diff = differences({ ...fixed, footerAt2of3: fixed.footer(2, 3) }, { ...before, footerAt2of3: before.footer(2, 3) }, "def", []);
    ok(`${name}${displayDate ? " (explicit date)" : ""}: only text direction changed`, diff.length === 0, diff.slice(0, 3).join("; "));
  }
  const header = buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle: TITLE }).content[0].text;
  ok(`${name}: the header is direction runs (Latin brand apart from the Hebrew)`, isDeepStrictEqual(header, [{ text: "Dubiz" }, { text: "מלאי · " }]), JSON.stringify(header));
}

console.log("the browser download hands pdfmake exactly the builder's definition (what a server renders)");
for (const [name, draft] of Object.entries(FIXTURES)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake stub
  let captured: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake stub
  (pdfMake as any).createPdf = (def: unknown) => {
    captured = def;
    return { download() {} };
  };
  downloadSupplierPurchaseOrderPdf(draft, { windowTitle: TITLE });
  const built = digest(buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle: TITLE }));
  ok(`${name}: download definition = builder definition`, captured !== null && digest(captured) === built, captured ? digest(captured) : "nothing captured");
}

console.log("the builder is pure");
{
  const before = JSON.stringify(FIXTURES.basic);
  buildSupplierPurchaseOrderDocDefinition(FIXTURES.basic, { headerTitle: TITLE });
  ok("the draft is not mutated", JSON.stringify(FIXTURES.basic) === before);
  ok("the number printed is the draft's id", JSON.stringify(buildSupplierPurchaseOrderDocDefinition(FIXTURES.basic, { headerTitle: TITLE })).includes('"#41"'));
  ok("the external number is printed when present", JSON.stringify(buildSupplierPurchaseOrderDocDefinition(FIXTURES.basic, { headerTitle: TITLE })).includes('"A-100"'));
}

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
