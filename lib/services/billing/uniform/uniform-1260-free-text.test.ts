/**
 * Field 1260 (D110 line description, alpha 30): free text made safe for ONE fixed-width record.
 *
 * Before the fix a line description containing a newline wrote a raw LF byte inside the D110 record, which breaks the
 * CRLF line structure of BKMVDATA. Plain descriptions must stay byte-identical (the certified files and the A0 golden).
 *
 *   npx tsx lib/services/billing/uniform/uniform-1260-free-text.test.ts
 */
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import type { UniformDocumentInput, UniformExportAssemblerInput } from "@/lib/services/billing/uniform/uniform-export.types";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import { formatAlpha, normalizeFreeText } from "@/lib/services/billing/uniform/uniform-field-format";
import { encodeIso8859_8i } from "@/lib/services/billing/uniform/uniform-encoding";
import { CRLF } from "@/lib/services/billing/uniform/uniform-serializer";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const before = (s: string) => encodeIso8859_8i(formatAlpha(s, 30));
const after = (s: string) => encodeIso8859_8i(formatAlpha(normalizeFreeText(s), 30));
const show = (b: Buffer) => [...b].map((x) => (x === 0x0a ? "<LF>" : x === 0x0d ? "<CR>" : x === 0x09 ? "<TAB>" : x >= 0xe0 && x <= 0xfa ? String.fromCharCode(0x05d0 + x - 0xe0) : String.fromCharCode(x))).join("");

// ---- the samples shown for review (before → after, 30 bytes each) ----------------------------------------------
const SAMPLES: [string, string][] = [
  ["plain Hebrew", "החלפת מסך"],
  ["Hebrew + digits", "שירות טכני 2 שעות"],
  ["LF inside", "החלפת מסך\nכולל הובלה"],
  ["CRLF inside", "החלפת מסך\r\nכולל הובלה"],
  ["TAB inside", "דגם\tX200"],
  ["niqqud", "שָׁלוֹם עולם"],
  ["maqaf", "דו־צדדי"],
  ["RLM mark", "‏מוצר 5"],
  ["emoji at the cut", "א".repeat(29) + "😀"],
  ["long Hebrew (45)", "ת".repeat(45)],
];
console.log("\n--- 1260 samples: before → after (30 bytes) ---");
for (const [name, v] of SAMPLES) console.log(`${name.padEnd(18)} | ${show(before(v))} | → | ${show(after(v))}`);
console.log("");

// ---- unit ----------------------------------------------------------------------------------------------------
ok("plain Hebrew is byte-identical", before("החלפת מסך").equals(after("החלפת מסך")));
ok("Hebrew + digits + ASCII is byte-identical", before("שירות טכני 2 שעות X-200").equals(after("שירות טכני 2 שעות X-200")));
ok("a long plain description is cut exactly as before", before("ת".repeat(45)).equals(after("ת".repeat(45))));
for (const [name, v] of SAMPLES) {
  const b = after(v);
  ok(`${name}: exactly 30 bytes, no LF / CR / TAB`, b.length === 30 && !b.includes(0x0a) && !b.includes(0x0d) && !b.includes(0x09), show(b));
}
ok("LF becomes one space", normalizeFreeText("א\nב") === "א ב");
ok("CRLF becomes one space (collapsed)", normalizeFreeText("א\r\nב") === "א ב");
ok("niqqud is removed, not turned into ?", normalizeFreeText("שָׁלוֹם") === "שלום");
ok("maqaf becomes -", normalizeFreeText("דו־צדדי") === "דו-צדדי");
ok("RLM is removed", normalizeFreeText("‏מוצר") === "מוצר");
ok("an emoji at the cut is ONE ?, not half a pair", [...after("א".repeat(29) + "😀")].filter((x) => x === 0x3f).length === 1);
ok("null → empty", normalizeFreeText(null) === "" && normalizeFreeText(undefined) === "");

// ---- end to end: the built BKMVDATA keeps one record per CRLF line ------------------------------------------
function doc(id: number, descriptions: string[]): UniformDocumentInput {
  return {
    id, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: id, documentNumberFormatted: String(id).padStart(8, "0"),
    issuedAt: "2026-06-15T10:05:00.000Z", lockedAt: "2026-06-15T10:05:00.000Z", currency: "ILS",
    subtotalAmount: "100.00", vatAmount: "17.00", totalAmount: "117.00", allocationNumber: null, allocationApprovedAt: null,
    isEmergencyAllocation: false, legalSnapshotHash: "h", referenceDocumentId: null,
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", taxIdType: "LTD_COMPANY", city: "תל אביב", phone: null, email: null },
    customerNameSnapshot: "לקוח",
    lines: descriptions.map((description, lineIndex) => ({
      lineIndex, description, quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00",
      lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00",
    })),
    payments: [], issuedSnapshot: null,
  };
}
const input: UniformExportAssemblerInput = {
  businessId: 3,
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" },
  business: {
    businessId: 3, name: "Dubiz", billingLegalName: "דוביז", billingBusinessKind: "LTD_COMPANY",
    billingTaxId: "515000123", billingVatNumber: "515000123", billingAddress: "רחוב הבדיקה 1", billingPhone: null, billingEmail: null,
  },
  documents: [doc(1, ["החלפת מסך\nכולל הובלה", "דגם\tX200", "שורה\r\nשנייה"])],
};
const built = buildUniformExportFiles(assembleUniformExportProjection(input), SIMULATOR_SOFTWARE_CONFIG, {
  primaryId: "123456789012345", generatedAt: "2026-06-20T14:30:00.000Z",
});
const records = built.bkmvdataText.split(CRLF).filter(Boolean);
const d110 = records.filter((r) => r.startsWith("D110"));
ok("E2E: three D110 records for three lines (none split by a newline)", d110.length === 3, d110.length);
ok("E2E: every record starts with a known record code", records.every((r) => /^(A100|B110|C100|D110|D120|Z900)/.test(r)), records.map((r) => r.slice(0, 4)));
ok("E2E: all D110 records have the same length", new Set(d110.map((r) => r.length)).size === 1);
ok("E2E: no raw LF / CR / TAB inside the BKMVDATA bytes except the CRLF terminators",
  !built.bkmvdataText.split(CRLF).join("").match(/[\n\r\t]/));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
