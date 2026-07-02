/**
 * WP1 — Uniform Export Assembler tests (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-export-assembler.test.ts
 *
 * Pure: no DB, no network, no env. Covers the 7 required checks.
 */
import { readFileSync } from "node:fs";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { loadUniformExportInput } from "@/lib/services/billing/uniform/uniform-export-loader";
import type {
  UniformDocumentInput,
  UniformExportAssemblerInput,
} from "@/lib/services/billing/uniform/uniform-export.types";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const PERIOD = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" };

function customer(taxId: string | null) {
  return {
    id: 7,
    name: "לקוח בדיקה",
    legalName: "לקוח בדיקה בע\"מ",
    taxId,
    taxIdType: "LTD_COMPANY",
    city: "תל אביב",
    phone: null,
    email: null,
  };
}

function line(i: number) {
  return {
    lineIndex: i,
    description: `שורה ${i}`,
    quantity: "1.0000",
    unitPrice: "100.0000",
    vatRatePercent: "17.00",
    lineSubtotal: "100.00",
    vatAmount: "17.00",
    lineTotal: "117.00",
  };
}

function baseDoc(over: Partial<UniformDocumentInput>): UniformDocumentInput {
  return {
    id: 0,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    documentNumber: 1,
    documentNumberFormatted: "00000001",
    issuedAt: "2026-06-15T10:00:00.000Z",
    lockedAt: "2026-06-15T10:00:00.000Z",
    currency: "ILS",
    subtotalAmount: "100.00",
    vatAmount: "16.00",
    totalAmount: "100.00",
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
    legalSnapshotHash: "hash",
    referenceDocumentId: null,
    customer: customer("514999999"),
    customerNameSnapshot: "לקוח בדיקה",
    lines: [line(0)],
    payments: [],
    issuedSnapshot: null,
    ...over,
  };
}

function buildInput(): UniformExportAssemblerInput {
  return {
    businessId: 3,
    period: PERIOD,
    business: {
      businessId: 3,
      name: "Dubiz",
      billingLegalName: "Dubiz בע\"מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "515000000",
      billingVatNumber: "515000000",
      billingAddress: "רחוב הבדיקה 1",
      billingPhone: "03-0000000",
      billingEmail: "biz@dubiz.test",
    },
    documents: [
      baseDoc({ id: 1, totalAmount: "100.00", vatAmount: "16.00" }),
      baseDoc({
        id: 2,
        documentType: "TAX_INVOICE_RECEIPT",
        totalAmount: "234.50",
        vatAmount: "34.50",
        issuedSnapshot: {
          document: { allocationNumber: "ALLOC-SNAP-2", currency: "ILS", numberFormatted: "00000002" },
          customer: customer("514888888"),
          lines: [line(0)],
          totals: { subtotal: "200.00", vat: "34.50", total: "234.50" },
        },
        payments: [
          {
            lineIndex: 0,
            method: "BANK_TRANSFER",
            amount: "234.50",
            currency: "ILS",
            paymentDate: "2026-06-15T10:00:00.000Z",
            bankName: "בנק",
            bankBranch: "1",
            bankAccountNumber: "123",
            checkNumber: null,
            checkDueDate: null,
            cardBrand: null,
            cardLast4: null,
            reference: null,
          },
        ],
      }),
      baseDoc({ id: 3, status: "DRAFT" }), // excluded: not issued
      baseDoc({ id: 4, documentType: "QUOTE" }), // excluded: quote
      baseDoc({ id: 5, issuedAt: "2026-05-01T10:00:00.000Z" }), // excluded: out of period
      baseDoc({
        id: 6,
        documentType: "RECEIPT",
        customer: null, // -> DOC_MISSING_CUSTOMER
        payments: [], // -> RECEIPT_WITHOUT_PAYMENTS
        totalAmount: "10.05",
        vatAmount: "0.00",
        lockedAt: null, // -> DOC_ISSUED_WITHOUT_LOCK
      }),
    ],
  };
}

// 1. Unit tests with dummy data + inclusion/exclusion (test #4)
{
  const proj = assembleUniformExportProjection(buildInput());
  ok("included documents are exactly the issued/non-quote/in-period set", proj.totals.documentCount === 3);
  const includedIds = proj.documentRecords.map((r) => r.documentId).sort((a, b) => a - b);
  ok("included ids = [1,2,6]", JSON.stringify(includedIds) === JSON.stringify([1, 2, 6]));
  const reasons = Object.fromEntries(proj.excluded.map((e) => [e.documentId, e.reason]));
  ok("doc3 excluded NOT_ISSUED", reasons[3] === "NOT_ISSUED:DRAFT");
  ok("doc4 excluded QUOTE", reasons[4] === "EXCLUDED_TYPE:QUOTE");
  ok("doc5 excluded OUT_OF_PERIOD", reasons[5] === "OUT_OF_PERIOD");

  // totals (decimal-string math)
  ok("sumTotal = 344.55", proj.totals.sumTotal === "344.55");
  ok("sumVat = 50.50", proj.totals.sumVat === "50.50");
  ok("byDocumentType counts", proj.totals.byDocumentType.TAX_INVOICE === 1 && proj.totals.byDocumentType.TAX_INVOICE_RECEIPT === 1 && proj.totals.byDocumentType.RECEIPT === 1);
}

// 5. No mock allocation EVER created
{
  const proj = assembleUniformExportProjection(buildInput());
  const d1 = proj.documentRecords.find((r) => r.documentId === 1)!;
  const d2 = proj.documentRecords.find((r) => r.documentId === 2)!;
  ok("doc1 has NO allocation (null in -> null out, source NONE)", d1.allocationNumber === null && d1.allocationSource === "NONE");
  ok("doc2 allocation copied from snapshot, not fabricated", d2.allocationNumber === "ALLOC-SNAP-2" && d2.allocationSource === "ISSUED_SNAPSHOT");
  ok("withAllocationCount counts only real ones", proj.totals.withAllocationCount === 1);

  // every output allocation must trace back to an input value (never invented)
  const inputAllocs = new Set<string>();
  for (const doc of buildInput().documents) {
    if (doc.allocationNumber) inputAllocs.add(doc.allocationNumber);
    const s = doc.issuedSnapshot?.document?.allocationNumber;
    if (s) inputAllocs.add(s);
  }
  const outAllocs = proj.documentRecords.map((r) => r.allocationNumber).filter((x): x is string => x != null);
  ok("output allocations ⊆ input allocations (no fabrication)", outAllocs.every((a) => inputAllocs.has(a)));

  // all-null input -> all-null output
  const nullInput = buildInput();
  nullInput.documents = nullInput.documents.map((d) => ({ ...d, allocationNumber: null, issuedSnapshot: null }));
  const nullProj = assembleUniformExportProjection(nullInput);
  ok("all-null allocation input -> zero allocations out", nullProj.totals.withAllocationCount === 0 && nullProj.documentRecords.every((r) => r.allocationNumber === null));
}

// 6. Missing fields -> warnings, never filled with guesses
{
  const input = buildInput();
  input.business.billingTaxId = null; // business missing tax id
  const proj = assembleUniformExportProjection(input);
  const codes = new Set(proj.warnings.map((w) => w.code));
  ok("BUSINESS_MISSING_TAX_ID warning emitted", codes.has("BUSINESS_MISSING_TAX_ID"));
  ok("business tax id stays null (not fabricated)", proj.business.billingTaxId === null);
  ok("DOC_MISSING_CUSTOMER warning for doc6", codes.has("DOC_MISSING_CUSTOMER"));
  ok("RECEIPT_WITHOUT_PAYMENTS warning for doc6", codes.has("RECEIPT_WITHOUT_PAYMENTS"));
  ok("DOC_ISSUED_WITHOUT_LOCK warning for doc6", codes.has("DOC_ISSUED_WITHOUT_LOCK"));
  const d6 = proj.documentRecords.find((r) => r.documentId === 6)!;
  ok("missing customer stays null", d6.customer === null);
}

// 3. Determinism: same input -> identical output; order-independent
{
  const a = JSON.stringify(assembleUniformExportProjection(buildInput()));
  const b = JSON.stringify(assembleUniformExportProjection(buildInput()));
  ok("same input -> identical JSON", a === b);

  const shuffled = buildInput();
  shuffled.documents = [...shuffled.documents].reverse();
  const c = JSON.stringify(assembleUniformExportProjection(shuffled));
  ok("document input order does not affect output (stable sort)", a === c);
}

// 2. Read-only: assembler does not mutate its input
{
  const input = buildInput();
  const before = JSON.stringify(input);
  assembleUniformExportProjection(input);
  ok("assembler does not mutate input (pure)", JSON.stringify(input) === before);
}

// 7. No OAuth/token dependency (source-level) + runs with env cleared
{
  const assemblerSrc = readFileSync("lib/services/billing/uniform/uniform-export-assembler.ts", "utf8");
  const loaderSrc = readFileSync("lib/services/billing/uniform/uniform-export-loader.ts", "utf8");
  const importLines = (src: string) => src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
  const forbidden = /oauth|authority|token|client_secret|accelerate/i;
  ok("assembler imports have no oauth/authority/token", !forbidden.test(importLines(assemblerSrc)));
  ok("loader imports have no oauth/authority/token", !forbidden.test(importLines(loaderSrc)));

  const savedEnv = process.env;
  process.env = {} as NodeJS.ProcessEnv; // prove no env dependency in the pure path
  try {
    const proj = assembleUniformExportProjection(buildInput());
    ok("assembler runs with empty env", proj.totals.documentCount === 3);
  } finally {
    process.env = savedEnv;
  }
}

// 2b. Loader is read-only: only findUnique/findMany are ever called
async function loaderReadOnlyTest() {
  const calls: string[] = [];
  const throwWrite = (name: string) => () => {
    throw new Error(`WRITE ATTEMPTED: ${name}`);
  };
  const fakeClient = {
    business: {
      findUnique: async () => {
        calls.push("business.findUnique");
        return { id: 3, name: "Dubiz", profile: { billingTaxId: "515000000", billingLegalName: "Dubiz", billingAddress: "addr" } };
      },
      create: throwWrite("business.create"),
      update: throwWrite("business.update"),
      delete: throwWrite("business.delete"),
      upsert: throwWrite("business.upsert"),
    },
    billingDocument: {
      findMany: async () => {
        calls.push("billingDocument.findMany");
        return [
          {
            id: 1,
            documentType: "TAX_INVOICE",
            status: "ISSUED",
            documentNumber: 1,
            documentNumberFormatted: "00000001",
            issuedAt: new Date("2026-06-15T10:00:00.000Z"),
            lockedAt: new Date("2026-06-15T10:00:00.000Z"),
            currency: "ILS",
            subtotalAmount: { toFixed: (d: number) => (100).toFixed(d) },
            vatAmount: { toFixed: (d: number) => (16).toFixed(d) },
            totalAmount: { toFixed: (d: number) => (116).toFixed(d) },
            allocationNumber: null,
            isEmergencyAllocation: false,
            legalSnapshotHash: "h",
            referenceDocumentId: null,
            customer: { id: 7, name: "C", taxId: "514", taxIdType: "LTD_COMPANY" },
            customerNameSnapshot: "C",
            lines: [],
            receiptPayments: [],
            issuedSnapshot: null,
          },
        ];
      },
      create: throwWrite("billingDocument.create"),
      update: throwWrite("billingDocument.update"),
      delete: throwWrite("billingDocument.delete"),
      updateMany: throwWrite("billingDocument.updateMany"),
    },
  };

  const input = await loadUniformExportInput({
    businessId: 3,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
    client: fakeClient as never,
  });
  ok("loader called only read methods", JSON.stringify(calls.sort()) === JSON.stringify(["billingDocument.findMany", "business.findUnique"]));
  ok("loader shaped one document", input.documents.length === 1 && input.documents[0].id === 1);
  ok("loader carried business tax id", input.business.billingTaxId === "515000000");

  // loader output is deterministic into the assembler
  const p1 = JSON.stringify(assembleUniformExportProjection(input));
  const p2 = JSON.stringify(assembleUniformExportProjection(input));
  ok("loader->assembler deterministic", p1 === p2);
}

async function run() {
  await loaderReadOnlyTest();
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll WP1 uniform export assembler tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
