/**
 * Package scope + readiness — pure proof (run: npx tsx lib/accountant/package-scope.verify.test.ts).
 */

import {
  centsToDecimal,
  computeFingerprint,
  dateTakenFromUpload,
  decimalToCents,
  evaluateReadiness,
  findPossibleDuplicateIncome,
  issuedTotalsByType,
  openItemCount,
  type IssuedDocumentFact,
  type PeriodFacts,
  type ScannedRecordFact,
} from "./package-scope";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function scanned(over: Partial<ScannedRecordFact> & { id: number }): ScannedRecordFact {
  return {
    documentId: over.id + 1000,
    amount: 100,
    date: new Date("2026-09-10T00:00:00Z"),
    direction: "expense",
    category: "general",
    vendorName: "ספק",
    documentCreatedAt: new Date("2026-09-11T08:00:00Z"),
    documentStatus: "approved",
    fileUrl: `doc-${over.id}.pdf`,
    ...over,
  };
}

function issued(over: Partial<IssuedDocumentFact> & { id: number }): IssuedDocumentFact {
  return {
    documentType: "TAX_INVOICE",
    documentNumberFormatted: `INV-${over.id}`,
    issuedAt: new Date("2026-09-10T09:00:00Z"),
    subtotalAmount: "100.00",
    vatAmount: "18.00",
    totalAmount: "118.00",
    currency: "ILS",
    customerName: "לקוח",
    referenceDocumentId: null,
    pdf: { available: true, storageKey: `biz/1/billing/${over.id}/${"a".repeat(64)}.pdf`, sha256: "a".repeat(64) },
    ...over,
  };
}

const identity = { legalName: "העסק שלי בע\"מ", taxId: "515151515" };

// ── money ──
ok("decimalToCents 118.00", decimalToCents("118.00") === BigInt(11800));
ok("decimalToCents 0.5", decimalToCents("0.5") === BigInt(50));
ok("decimalToCents -12.34", decimalToCents("-12.34") === BigInt(-1234));
ok("centsToDecimal round trip", centsToDecimal(decimalToCents("1234567.89")) === "1234567.89");
ok("centsToDecimal negative", centsToDecimal(BigInt(-5)) === "-0.05");
let threw = false;
try {
  decimalToCents("1e3");
} catch {
  threw = true;
}
ok("decimalToCents refuses exponent notation", threw);

// ── date taken from upload ──
ok(
  "date == upload time is flagged",
  dateTakenFromUpload({ date: new Date("2026-09-11T08:00:00Z"), documentCreatedAt: new Date("2026-09-11T08:00:00Z") })
);
ok(
  "a real document date is not flagged",
  !dateTakenFromUpload({ date: new Date("2026-09-10T00:00:00Z"), documentCreatedAt: new Date("2026-09-11T08:00:00Z") })
);

// ── duplicates (warnings only) ──
{
  const pairs = findPossibleDuplicateIncome(
    [
      scanned({ id: 1, direction: "income", amount: 118, date: new Date("2026-09-12T00:00:00Z") }),
      scanned({ id: 2, direction: "income", amount: 118, date: new Date("2026-09-12T00:00:00Z") }),
      scanned({ id: 3, direction: "expense", amount: 118 }),
      scanned({ id: 4, direction: "income", amount: 500, date: new Date("2026-09-25T00:00:00Z") }),
    ],
    [issued({ id: 10 })],
    identity
  );
  ok("one issued invoice matches one scanned income record", pairs.length === 1);
  ok("the lower id is matched first", pairs[0]?.recordId === 1 && pairs[0]?.billingDocumentId === 10);
  ok("expense records are never matched", !pairs.some((p) => p.recordId === 3));

  const far = findPossibleDuplicateIncome(
    [scanned({ id: 5, direction: "income", amount: 118, date: new Date("2026-09-20T00:00:00Z") })],
    [issued({ id: 11 })],
    identity
  );
  ok("same amount 10 days apart is not a duplicate", far.length === 0);

  const byName = findPossibleDuplicateIncome(
    [scanned({ id: 6, direction: "income", amount: 118, vendorName: "העסק שלי בעמ", date: new Date("2026-09-28T00:00:00Z") })],
    [issued({ id: 12 })],
    identity
  );
  ok("own legal name + same amount is a duplicate even outside the window", byName.length === 1);

  const creditNote = findPossibleDuplicateIncome(
    [scanned({ id: 7, direction: "income", amount: 118 })],
    [issued({ id: 13, documentType: "CREDIT_NOTE" })],
    identity
  );
  ok("credit notes are not duplicate candidates", creditNote.length === 0);
}

// ── totals per type, never across types ──
{
  const totals = issuedTotalsByType([
    issued({ id: 1, totalAmount: "118.00", vatAmount: "18.00" }),
    issued({ id: 2, totalAmount: "0.10", vatAmount: "0.02" }),
    issued({ id: 3, documentType: "CREDIT_NOTE", totalAmount: "-50.00", vatAmount: "-7.63" }),
    issued({ id: 4, documentType: "RECEIPT", totalAmount: "118.00", vatAmount: "0.00" }),
  ]);
  ok("three types", totals.length === 3);
  ok("ordered invoice → receipt → credit note", totals.map((t) => t.documentType).join(",") === "TAX_INVOICE,RECEIPT,CREDIT_NOTE");
  ok("invoice total exact (no float drift)", totals[0].totalAmount === "118.10" && totals[0].vatAmount === "18.02");
  ok("credit note kept negative and separate", totals[2].totalAmount === "-50.00");
  ok("every total is labelled ILS", totals.every((t) => t.currency === "ILS"));
}

// ── totals never add two currencies ──
{
  const totals = issuedTotalsByType([
    issued({ id: 1, totalAmount: "118.00", vatAmount: "18.00" }),
    issued({ id: 2, totalAmount: "100.00", vatAmount: "0.00", currency: "USD" }),
    issued({ id: 3, totalAmount: "2.00", vatAmount: "0.00", currency: "USD" }),
  ]);
  ok("one invoice total per currency", totals.length === 2 && totals.every((t) => t.documentType === "TAX_INVOICE"));
  ok("ILS first, then USD", totals.map((t) => t.currency).join(",") === "ILS,USD");
  ok("the ILS total holds only ILS", totals[0].totalAmount === "118.00" && totals[0].count === 1);
  ok("the USD total holds only USD", totals[1].totalAmount === "102.00" && totals[1].count === 2);
}

// ── readiness ──
const clean: PeriodFacts = {
  scanned: [scanned({ id: 1 }), scanned({ id: 2, direction: "income", amount: 40 })],
  issued: [issued({ id: 10 })],
  pending: [],
  identity,
};
{
  const r = evaluateReadiness(clean);
  ok("nothing open → READY", r.status === "READY" && r.blockers.length === 0);
  ok("counts", r.counts.scannedExpense === 1 && r.counts.scannedIncome === 1 && r.counts.issued === 1 && r.counts.pending === 0);
  ok("open items 0", openItemCount(r) === 0);
}
{
  const r = evaluateReadiness({
    ...clean,
    pending: [
      { id: 7, status: "needs_review", createdAt: new Date("2026-09-03T10:00:00Z"), extractedDate: null },
      { id: 8, status: "failed", createdAt: new Date("2026-09-04T10:00:00Z"), extractedDate: null },
    ],
  });
  ok("pending documents block", r.status === "NEEDS_ATTENTION");
  ok("pending blocker lists both", r.blockers[0]?.kind === "DOCUMENTS_PENDING_REVIEW" && r.blockers[0].count === 2);
}
{
  const r = evaluateReadiness({ ...clean, issued: [issued({ id: 10, pdf: { available: false, reason: "AUTHORITY_NOT_DELIVERABLE" } })] });
  ok("an issued document without a deliverable PDF blocks", r.status === "NEEDS_ATTENTION" && r.blockers[0]?.kind === "ISSUED_PDF_UNAVAILABLE");
}
{
  const r = evaluateReadiness(clean, [1001, 1001]);
  ok("missing originals block, deduplicated", r.blockers[0]?.kind === "ORIGINAL_FILES_MISSING" && r.blockers[0].count === 1);
  ok("open items count every blocker item", openItemCount(r) === 1);
}
{
  const r = evaluateReadiness({
    ...clean,
    scanned: [scanned({ id: 3, date: new Date("2026-09-11T08:00:00Z"), documentCreatedAt: new Date("2026-09-11T08:00:00Z") })],
  });
  ok("a guessed date is a WARNING, not a blocker", r.status === "READY" && r.warnings[0]?.kind === "DATE_FROM_UPLOAD_TIME");
}

// ── fingerprint ──
{
  const a = computeFingerprint(clean);
  const b = computeFingerprint({ ...clean, scanned: [...clean.scanned].reverse(), issued: [...clean.issued] });
  ok("fingerprint is order-independent", a === b);
  ok("fingerprint is hex sha256", /^[0-9a-f]{64}$/.test(a));
  ok("a late approved record changes it", computeFingerprint({ ...clean, scanned: [...clean.scanned, scanned({ id: 9 })] }) !== a);
  ok(
    "a PDF becoming available changes it",
    computeFingerprint({ ...clean, issued: [issued({ id: 10, pdf: { available: false, reason: "NOT_RENDERED" } })] }) !== a
  );
  ok(
    "a pending document being reviewed changes it",
    computeFingerprint({ ...clean, pending: [{ id: 7, status: "needs_review", createdAt: new Date(), extractedDate: null }] }) !== a
  );
  ok("identity alone does not change it", computeFingerprint({ ...clean, identity: { legalName: "x", taxId: null } }) === a);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\npackage-scope: all checks passed");
