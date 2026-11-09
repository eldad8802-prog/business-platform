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
 * Run: npx tsx lib/services/business-documents/po-sheet/supplier-document-unchanged.test.ts
 */
process.env.TZ = "Asia/Jerusalem";

import { createHash } from "node:crypto";

import pdfMake from "pdfmake/build/pdfmake";

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

console.log("the browser download hands pdfmake exactly the original definition");
for (const [name, draft] of Object.entries(FIXTURES)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake stub
  let captured: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfmake stub
  (pdfMake as any).createPdf = (def: unknown) => {
    captured = def;
    return { download() {} };
  };
  downloadSupplierPurchaseOrderPdf(draft, { windowTitle: TITLE });
  ok(`${name}: download definition = original`, captured !== null && digest(captured) === ORIGINAL[name], captured ? digest(captured) : "nothing captured");
}

console.log("the extracted builder (what a server renders) produces that same definition");
for (const [name, draft] of Object.entries(FIXTURES)) {
  ok(`${name}: builder with the same header = original`, digest(buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle: TITLE })) === ORIGINAL[name]);
  ok(
    `${name}: an explicit date equal to the browser's gives the same document`,
    digest(buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle: TITLE, displayDate: formatSupplierDraftDisplayDate(draft) })) === ORIGINAL[name]
  );
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
