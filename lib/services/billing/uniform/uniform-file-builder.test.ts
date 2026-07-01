/**
 * WP2 integration tests (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-file-builder.test.ts
 *
 * Builds a deterministic WP1 projection → WP2 files, and asserts byte-exact
 * field values at exact spec column positions, record lengths, counts, and
 * packaging path. Ends with a disk-write smoke test (INI.TXT + BKMVDATA.zip).
 */
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import type {
  UniformDocumentInput,
  UniformExportAssemblerInput,
} from "@/lib/services/billing/uniform/uniform-export.types";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import {
  buildUniformExportFiles,
  computeOpenfrmtPath,
} from "@/lib/services/billing/uniform/uniform-file-builder";
import { CRLF } from "@/lib/services/billing/uniform/uniform-serializer";
import { writeUniformExport } from "@/lib/services/billing/uniform/uniform-packaging";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  console.log("OK:", name);
}
/** 1-based inclusive field slice. */
const F = (rec: string, start: number, len: number) => rec.slice(start - 1, start - 1 + len);

const PRIMARY = "123456789012345";
const GEN_AT = "2026-06-20T14:30:00.000Z";

function line() {
  return {
    lineIndex: 0,
    description: "שירות",
    quantity: "1.0000",
    unitPrice: "100.0000",
    vatRatePercent: "17.00",
    lineSubtotal: "100.00",
    vatAmount: "17.00",
    lineTotal: "117.00",
  };
}
function doc(over: Partial<UniformDocumentInput>): UniformDocumentInput {
  return {
    id: 0,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    documentNumber: 1,
    documentNumberFormatted: "00000001",
    issuedAt: "2026-06-15T10:05:00.000Z",
    lockedAt: "2026-06-15T10:05:00.000Z",
    currency: "ILS",
    subtotalAmount: "100.00",
    vatAmount: "17.00",
    totalAmount: "117.00",
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
    legalSnapshotHash: "h",
    referenceDocumentId: null,
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", taxIdType: "LTD_COMPANY", city: "תל אביב", phone: null, email: null },
    customerNameSnapshot: "לקוח",
    lines: [line()],
    payments: [],
    issuedSnapshot: null,
    ...over,
  };
}

const input: UniformExportAssemblerInput = {
  businessId: 3,
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" },
  business: {
    businessId: 3,
    name: "Dubiz",
    billingLegalName: "דוביז",
    billingBusinessKind: "LTD_COMPANY",
    billingTaxId: "515000123",
    billingVatNumber: "515000123",
    billingAddress: "רחוב הבדיקה 1",
    billingPhone: null,
    billingEmail: null,
  },
  documents: [
    doc({ id: 1, documentNumber: 1, documentNumberFormatted: "00000001" }),
    doc({
      id: 2,
      documentType: "RECEIPT",
      documentNumber: 2,
      documentNumberFormatted: "00000002",
      issuedAt: "2026-06-20T09:00:00.000Z",
      subtotalAmount: "50.00",
      vatAmount: "0.00",
      totalAmount: "50.00",
      lines: [],
      payments: [
        {
          lineIndex: 0,
          method: "BANK_TRANSFER",
          amount: "50.00",
          currency: "ILS",
          paymentDate: "2026-06-20T09:00:00.000Z",
          bankName: null,
          bankBranch: null,
          bankAccountNumber: null,
          checkNumber: null,
          checkDueDate: null,
          cardBrand: null,
          cardLast4: null,
          reference: null,
        },
      ],
    }),
    doc({
      id: 3,
      documentType: "TAX_INVOICE_RECEIPT",
      documentNumber: 3,
      documentNumberFormatted: "00000003",
      issuedAt: "2026-06-25T12:00:00.000Z",
      subtotalAmount: "200.00",
      vatAmount: "34.50",
      totalAmount: "234.50",
      customer: { id: 9, name: "לקוח3", legalName: null, taxId: "512000000", taxIdType: "LTD_COMPANY", city: null, phone: null, email: null },
      lines: [line()],
      payments: [
        {
          lineIndex: 0,
          method: "CHECK",
          amount: "234.50",
          currency: "ILS",
          paymentDate: "2026-06-25T12:00:00.000Z",
          bankName: "12",
          bankBranch: "345",
          bankAccountNumber: "6789",
          checkNumber: "111",
          checkDueDate: "2026-07-25T00:00:00.000Z",
          cardBrand: null,
          cardLast4: null,
          reference: null,
        },
      ],
    }),
  ],
};

const proj = assembleUniformExportProjection(input);
const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, {
  primaryId: PRIMARY,
  generatedAt: GEN_AT,
});

const bkmv = built.bkmvdataText.split(CRLF).filter(Boolean);
const ini = built.iniText.split(CRLF).filter(Boolean);
const a100 = bkmv.find((r) => r.startsWith("A100"))!;
const c100s = bkmv.filter((r) => r.startsWith("C100"));
const d110s = bkmv.filter((r) => r.startsWith("D110"));
const d120s = bkmv.filter((r) => r.startsWith("D120"));
const z900 = bkmv.find((r) => r.startsWith("Z900"))!;
const a000 = ini.find((r) => r.startsWith("A000"))!;
const summaries = ini.filter((r) => !r.startsWith("A000"));

// ---- record counts / totals ----
ok("counts: C100=3 D110=2 D120=2", built.meta.counts.C100 === 3 && built.meta.counts.D110 === 2 && built.meta.counts.D120 === 2, built.meta.counts);
ok("total BKMVDATA records = 9", built.meta.totalBkmvRecords === 9, built.meta.totalBkmvRecords);
ok("BKMVDATA line count = 9", bkmv.length === 9);

// ---- record lengths (spec §2.5.ה) ----
ok("A100 len 95", a100.length === 95);
ok("all C100 len 444", c100s.every((r) => r.length === 444));
ok("all D110 len 339", d110s.every((r) => r.length === 339));
ok("all D120 len 222", d120s.every((r) => r.length === 222));
ok("Z900 len 110", z900.length === 110);
ok("A000 len 466", a000.length === 466);
ok("summaries len 19", summaries.every((r) => r.length === 19));

// ---- A000 field positions ----
ok("A000 code", F(a000, 1, 4) === "A000");
ok("A000 1002 total=9", F(a000, 10, 15) === "000000000000009", F(a000, 10, 15));
ok("A000 1003 עוסק", F(a000, 25, 9) === "515000123");
ok("A000 1004 primaryId", F(a000, 34, 15) === PRIMARY);
ok("A000 1005 &OF1.31&", F(a000, 49, 8) === "&OF1.31&");
ok("A000 1006 reg (simulator)", F(a000, 57, 8) === "00000001");
ok("A000 1011 softwareType=2", F(a000, 134, 1) === "2");
ok("A000 1013 accounting=0", F(a000, 185, 1) === "0");
ok("A000 1024 period start", F(a000, 367, 8) === "20260601");
ok("A000 1029 charset=1", F(a000, 396, 1) === "1");
ok("A000 1032 currency ILS", F(a000, 417, 3) === "ILS");
ok("A000 1015 ח\"פ (LTD)", F(a000, 187, 9) === "515000123");

// ---- INI summaries ----
ok("summary C100=3", summaries[0] === "C100" + "000000000000003", summaries[0]);
ok("summary D110=2", summaries[1] === "D110" + "000000000000002");
ok("summary D120=2", summaries[2] === "D120" + "000000000000002");

// ---- C100 (doc1) ----
const c1 = c100s[0];
ok("C100 code", F(c1, 1, 4) === "C100");
ok("C100 1203 type=305 (TAX_INVOICE)", F(c1, 23, 3) === "305");
ok("C100 1204 docNumber", F(c1, 26, 20) === "00000001            ", JSON.stringify(F(c1, 26, 20)));
ok("C100 1205 date", F(c1, 46, 8) === "20260615");
ok("C100 1207 customer name", F(c1, 58, 4) === "לקוח");
ok("C100 1215 customer taxId", F(c1, 253, 9) === "514000000");
ok("C100 1219 subtotal", F(c1, 288, 15) === "+00000000010000");
ok("C100 1222 vat", F(c1, 333, 15) === "+00000000001700");
ok("C100 1223 total incl vat", F(c1, 348, 15) === "+00000000011700");
ok("C100 1234 link=documentId", F(c1, 425, 7) === "0000001");

// ---- doc types on other docs ----
ok("C100 doc2 type=400 (RECEIPT)", F(c100s[1], 23, 3) === "400");
ok("C100 doc3 type=320 (TAX_INVOICE_RECEIPT)", F(c100s[2], 23, 3) === "320");

// ---- D110 (doc1 line) ----
const l1 = d110s[0];
ok("D110 code", F(l1, 1, 4) === "D110");
ok("D110 1255 line#=1", F(l1, 46, 4) === "0001");
ok("D110 1264 quantity(4dp)", F(l1, 224, 17) === "+0000000000010000", F(l1, 224, 17));
ok("D110 1265 unit price(2dp)", F(l1, 241, 15) === "+00000000010000");
ok("D110 1267 line total", F(l1, 271, 15) === "+00000000011700");
ok("D110 1268 VAT rate=1700", F(l1, 286, 4) === "1700");
ok("D110 1263 unit default יחידה", F(l1, 204, 6) === "יחידה ");

// ---- D120 (doc2 payment = BANK_TRANSFER) ----
const p1 = d120s.find((r) => F(r, 23, 3) === "400")!;
ok("D120 code", F(p1, 1, 4) === "D120");
ok("D120 1306 method=4 (BANK_TRANSFER)", F(p1, 50, 1) === "4");
ok("D120 1312 amount 50.00", F(p1, 104, 15) === "+00000000005000");
// doc3 CHECK payment → bank fields filled + method=2
const p2 = d120s.find((r) => F(r, 23, 3) === "320")!;
ok("D120 CHECK method=2", F(p2, 50, 1) === "2");
ok("D120 CHECK bank(1307)=12", F(p2, 51, 10) === "0000000012");
ok("D120 CHECK check#(1310)=111", F(p2, 86, 10) === "0000000111");
ok("D120 CHECK due date(1311)", F(p2, 96, 8) === "20260725");

// ---- Z900 ----
ok("Z900 code", F(z900, 1, 4) === "Z900");
ok("Z900 1155 total=9 (== A000 1002)", F(z900, 46, 15) === "000000000000009");
ok("Z900 1151 recNo=9", F(z900, 5, 9) === "000000009");
ok("A100 1101 recNo=1", F(a100, 5, 9) === "000000001");

// ---- CRLF + encoding ----
ok("records terminated by CRLF", built.bkmvdataText.endsWith(CRLF) && built.iniText.endsWith(CRLF));
ok("encoding is single-byte (buffer len == text len)", built.iniBuffer.length === built.iniText.length && built.bkmvdataBuffer.length === built.bkmvdataText.length);
ok("Hebrew encoded to 0xE0-0xFA range", built.bkmvdataBuffer.includes(0xec)); // ל in לקוח

// ---- packaging path ----
ok(
  "OPENFRMT path",
  computeOpenfrmtPath("515000123", GEN_AT) === "OPENFRMT/51500012.26/06201430",
  computeOpenfrmtPath("515000123", GEN_AT)
);

// ---- disk smoke test ----
async function diskSmoke() {
  const root = mkdtempSync(join(tmpdir(), "uniform-"));
  const res = await writeUniformExport(root, built);
  ok("INI.TXT written", existsSync(res.iniPath) && statSync(res.iniPath).size === built.iniBuffer.length);
  ok("BKMVDATA.zip written", existsSync(res.bkmvdataZipPath) && statSync(res.bkmvdataZipPath).size > 0);
}

diskSmoke()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} test(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll WP2 file-builder tests passed.");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
