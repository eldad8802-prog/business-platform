/**
 * D110 fields 1256 / 1257 for a credit note: the base document is the issued source invoice `referenceDocumentId`
 * points at (same business; the issue path requires it and it is immutable after issue). No schema change.
 *
 *   npx tsx lib/services/billing/uniform/uniform-credit-base-document.test.ts
 */
import { loadUniformExportInput, type UniformExportReadClient } from "@/lib/services/billing/uniform/uniform-export-loader";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
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
const dec = (n: number) => ({ toFixed: (d: number) => n.toFixed(d) });
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1, businessId: 3, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 12, documentNumberFormatted: "000012",
    issuedAt: new Date("2026-07-15T10:00:00.000Z"), lockedAt: new Date("2026-07-15T10:00:00.000Z"), currency: "ILS",
    subtotalAmount: dec(100), vatAmount: dec(18), totalAmount: dec(118), allocationNumber: null, isEmergencyAllocation: false,
    legalSnapshotHash: "h", referenceDocumentId: null,
    customer: { id: 7, name: "לקוח", taxId: "514000000", taxIdType: "LTD_COMPANY" }, customerNameSnapshot: "לקוח",
    lines: [{ lineIndex: 0, description: "שירות", quantity: dec(1), unitPrice: dec(100), vatRatePercent: dec(18), lineSubtotal: dec(100), vatAmount: dec(18), lineTotal: dec(118) }],
    receiptPayments: [], issuedSnapshot: null,
    ...over,
  };
}
/** first findMany = the period's documents; second = the sources asked for (recorded) */
function client(periodRows: Record<string, unknown>[], sourceRows: Record<string, unknown>[], calls: unknown[]): UniformExportReadClient {
  let n = 0;
  return {
    business: { findUnique: async () => ({ name: "Dubiz", profile: { billingTaxId: "515000123", billingLegalName: "דוביז", billingBusinessKind: "LTD_COMPANY" } }) },
    billingDocument: { findMany: async (args: unknown) => { calls.push(args); n += 1; return n === 1 ? periodRows : sourceRows; } },
  };
}
async function d110For(periodRows: Record<string, unknown>[], sourceRows: Record<string, unknown>[]) {
  const calls: unknown[] = [];
  const input = await loadUniformExportInput({ businessId: 3, periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.999Z", client: client(periodRows, sourceRows, calls) });
  const proj = assembleUniformExportProjection(input);
  const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, { primaryId: "123456789012345", generatedAt: "2026-08-01T07:15:00.000Z" });
  const recs = built.bkmvdataText.split(CRLF).filter((r) => r.startsWith("D110"));
  // D110: code(4) 1251(9) 1252(9) 1253(3) 1254(20) 1255(4) → 1256 at 49..52, 1257 at 52..72
  const fields = recs.map((r) => ({ f1256: r.slice(49, 52), f1257: r.slice(52, 72).trim() }));
  return { fields, calls, warnings: proj.warnings ?? [] };
}

const invoice = row({ id: 1001, documentNumber: 12, documentNumberFormatted: "000012" });
const credit = row({ id: 4001, documentType: "CREDIT_NOTE", documentNumber: 2, documentNumberFormatted: "000002", referenceDocumentId: 1001 });

async function main() {
  // 1. credit + its source in the same period
  {
    const r = await d110For([invoice, credit], [invoice]);
    const cr = r.fields[1];
    ok("credit line: 1256 = 305 (the source is a tax invoice)", cr.f1256 === "305", cr);
    ok("credit line: 1257 = the source's printed number", cr.f1257 === "000012", cr);
    ok("the invoice's own line keeps 1256 empty (zero-filled numeric) and 1257 blank", r.fields[0].f1256 === "000" && r.fields[0].f1257 === "", r.fields[0]);
    const q = r.calls[1] as { where: Record<string, unknown> };
    ok("the source read is scoped: same business, the referenced ids, ISSUED, TAX_INVOICE",
      q && q.where.businessId === 3 && JSON.stringify(q.where.id) === JSON.stringify({ in: [1001] }) && q.where.status === "ISSUED" && q.where.documentType === "TAX_INVOICE", q);
  }
  // 2. the source predates the period (not among the period's rows)
  {
    const r = await d110For([credit], [invoice]);
    ok("source issued before the period: still 305 + its number", r.fields[0].f1256 === "305" && r.fields[0].f1257 === "000012", r.fields[0]);
  }
  // 3. the frozen snapshot's number wins over the live column (same rule as 1204)
  {
    const snapInvoice = row({ id: 1001, documentNumberFormatted: "000012", issuedSnapshot: { document: { numberFormatted: "INV-000012" } } });
    const r = await d110For([credit], [snapInvoice]);
    ok("1257 = the snapshot's formatted number when present", r.fields[0].f1257 === "INV-000012", r.fields[0]);
  }
  // 4. old data: a credit with no reference
  {
    const r = await d110For([row({ ...credit, referenceDocumentId: null })], []);
    ok("credit without a source: 1256 empty, 1257 blank (never guessed)", r.fields[0].f1256 === "000" && r.fields[0].f1257 === "", r.fields[0]);
    ok("credit without a source: the export warns CREDIT_WITHOUT_SOURCE_DOCUMENT", r.warnings.some((w) => w.code === "CREDIT_WITHOUT_SOURCE_DOCUMENT"));
    ok("no source query when no credit references one", r.calls.length === 1, r.calls.length);
  }
  // 5. the client returns something the query did not ask for (defense in depth)
  {
    const r = await d110For([credit], [row({ id: 1001, status: "DRAFT" }), row({ id: 999, documentNumberFormatted: "999" })]);
    ok("a non-issued or unrequested row is ignored → fields empty + warning",
      r.fields[0].f1256 === "000" && r.fields[0].f1257 === "" && r.warnings.some((w) => w.code === "CREDIT_WITHOUT_SOURCE_DOCUMENT"), r.fields[0]);
  }
  // 6. no credit → exactly the previous behaviour (one query)
  {
    const r = await d110For([invoice], []);
    ok("no credit in the period: one query, fields as before", r.calls.length === 1 && r.fields[0].f1256 === "000" && r.fields[0].f1257 === "", r);
  }
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  if (failed) process.exit(1);
}
main();
