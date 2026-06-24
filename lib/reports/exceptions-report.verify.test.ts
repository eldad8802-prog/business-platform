/**
 * Exceptions Report + Month-Close pure-logic verify (run manually, no DB):
 *   npx tsx lib/reports/exceptions-report.verify.test.ts
 */

import {
  buildExceptionsXlsxBuffer,
  computeExceptionRows,
  summarizeExceptions,
  type ApprovedRecordInput,
  type PendingDocInput,
} from "@/lib/reports/exceptions-report";
import { computeMonthSnapshotHash } from "@/lib/services/accounting/month-close.service";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const GOOD_FILE = "doc-123-abc12345.pdf";

const cleanApproved: ApprovedRecordInput = {
  id: 1,
  amount: 117,
  date: new Date(2026, 5, 10),
  vendorName: "ספק תקין",
  vendorTaxId: "514999999",
  document: { id: 10, status: "approved", fileUrl: GOOD_FILE },
};

const missingAmountApproved: ApprovedRecordInput = {
  id: 2,
  amount: 0,
  date: new Date(2026, 5, 11),
  vendorName: "ספק",
  vendorTaxId: "514888888",
  document: { id: 11, status: "approved", fileUrl: "doc-11-aa11bb22.pdf" },
};

const missingVendorApproved: ApprovedRecordInput = {
  id: 3,
  amount: 50,
  date: new Date(2026, 5, 12),
  vendorName: "   ",
  vendorTaxId: null, // also missing tax id → Warning MISSING_VENDOR_TAX_ID
  document: { id: 12, status: "approved", fileUrl: "doc-12-cc33dd44.pdf" },
};

const pendingDoc: PendingDocInput = {
  id: 20,
  status: "pending",
  fileUrl: "doc-20-ee55ff66.pdf",
  extractedData: { amount: null, date: null, vendorName: null, vendorTaxId: null },
};

// --- computeExceptionRows ---
const rows = computeExceptionRows({
  approvedRecords: [cleanApproved, missingAmountApproved, missingVendorApproved],
  pendingDocs: [pendingDoc],
  // cleanApproved's file is reported missing by the packaging set:
  missingFileDocIds: new Set<number>([10]),
});

function has(
  typeKey: string,
  severity: string,
  recordId: number
): boolean {
  return rows.some(
    (r) => r.typeKey === typeKey && r.severity === severity && r.recordId === recordId
  );
}

ok("clean record yields no amount/vendor/date exception", !has("MISSING_AMOUNT", "Critical", 1) && !has("MISSING_VENDOR", "Warning", 1));
ok("missing source file (from packaged-missing set) is Critical", has("MISSING_SOURCE_FILE", "Critical", 1));
ok("zero amount approved → Critical MISSING_AMOUNT", has("MISSING_AMOUNT", "Critical", 2));
ok("blank vendor approved → Warning MISSING_VENDOR", has("MISSING_VENDOR", "Warning", 3));
ok("pending doc → Warning PENDING_NOT_APPROVED", has("PENDING_NOT_APPROVED", "Warning", 20));
ok("pending doc missing amount → Critical", has("MISSING_AMOUNT", "Critical", 20));

// Phase B — Missing Vendor Tax ID (Warning), only when the field is empty.
ok("record WITH tax id → no MISSING_VENDOR_TAX_ID", !has("MISSING_VENDOR_TAX_ID", "Warning", 1) && !has("MISSING_VENDOR_TAX_ID", "Warning", 2));
ok("approved without tax id → Warning MISSING_VENDOR_TAX_ID", has("MISSING_VENDOR_TAX_ID", "Warning", 3));
ok("pending without tax id → Warning MISSING_VENDOR_TAX_ID", has("MISSING_VENDOR_TAX_ID", "Warning", 20));
ok("no NOT-AVAILABLE Info rows remain", rows.every((r) => r.severity !== "Info"));

// --- summarizeExceptions ---
const result = summarizeExceptions(rows);
const manualCritical = rows.filter((r) => r.severity === "Critical").length;
const manualWarning = rows.filter((r) => r.severity === "Warning").length;
ok("summary critical total matches", result.totals.critical === manualCritical);
ok("summary warning total matches", result.totals.warning === manualWarning);
ok("summary info total is 0", result.totals.info === 0);
ok("summary type rows present", result.summary.length > 0);

// --- empty dataset → no rows at all ---
const empty = summarizeExceptions(
  computeExceptionRows({ approvedRecords: [], pendingDocs: [], missingFileDocIds: new Set() })
);
ok("empty dataset → no critical", empty.totals.critical === 0);
ok("empty dataset → no rows", empty.totals.total === 0);

// --- computeMonthSnapshotHash determinism / order-independence ---
const recA = { id: 1, amount: 10, date: new Date(2026, 5, 1), vendorName: "A", category: "x", direction: "expense" };
const recB = { id: 2, amount: 20, date: new Date(2026, 5, 2), vendorName: "B", category: "y", direction: "income" };
const h1 = computeMonthSnapshotHash([recA, recB]);
const h2 = computeMonthSnapshotHash([recB, recA]);
const h3 = computeMonthSnapshotHash([recA, { ...recB, amount: 999 }]);
ok("snapshot hash is order-independent", h1 === h2);
ok("snapshot hash changes with content", h1 !== h3);
ok("snapshot hash is sha256 hex", /^[0-9a-f]{64}$/.test(h1));

// --- xlsx buffer is a real (zip) workbook ---
(async () => {
  const buf = await buildExceptionsXlsxBuffer(result, "2026-06");
  const isZip = buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b;
  ok("exceptions xlsx is a non-empty zip/xlsx buffer", isZip);

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll exceptions-report checks passed.");
})();
