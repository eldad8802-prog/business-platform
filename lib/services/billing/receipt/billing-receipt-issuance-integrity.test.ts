/**
 * Run: npx tsx lib/services/billing/receipt/billing-receipt-issuance-integrity.test.ts
 *
 * C2.5 — issuance-time allocation integrity: the pure rule, the lock order,
 * and the structural proof that the binding check lives inside issuance.
 *
 * The concurrency property itself cannot be proven without a database; the
 * PostgreSQL battery in .c25integrity/ does that. This file proves the parts
 * that do not need one, and pins the wiring so a later edit cannot quietly
 * move the check outside the issuance transaction or drop the lock.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Prisma } from "@prisma/client";
import { assertReceiptAllocationsMatchTotal } from "./billing-receipt-allocation.rules";
import { orderedUniqueIds } from "./billing-receipt-issuance-integrity";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
function read(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), "utf8");
}
const D = (v: string) => new Prisma.Decimal(v);
const alloc = (...amounts: string[]) =>
  amounts.map((a) => ({ allocatedAmount: D(a) }));

// ── receipt total = allocation total ──────────────────────────────────────
ok(
  "zero allocations is a legitimate ad-hoc receipt",
  !throws(() => assertReceiptAllocationsMatchTotal([], D("300.00")))
);
ok(
  "exact match passes",
  !throws(() => assertReceiptAllocationsMatchTotal(alloc("1000.00"), D("1000.00")))
);
ok(
  "split across invoices passes when it sums exactly",
  !throws(() =>
    assertReceiptAllocationsMatchTotal(alloc("400.00", "600.00"), D("1000.00"))
  )
);
ok(
  "E4 OVER: 1,000 allocated from a 300 receipt is refused",
  throws(() => assertReceiptAllocationsMatchTotal(alloc("1000.00"), D("300.00")))
);
ok(
  "E4 UNDER: 300 allocated from a 1,000 receipt is refused",
  throws(() => assertReceiptAllocationsMatchTotal(alloc("300.00"), D("1000.00")))
);
ok(
  "off by one agora is refused",
  throws(() => assertReceiptAllocationsMatchTotal(alloc("999.99"), D("1000.00")))
);

// ── lock order ────────────────────────────────────────────────────────────
ok(
  "locks are taken in ascending id order regardless of input order",
  JSON.stringify(orderedUniqueIds([9, 2, 5])) === "[2,5,9]"
);
ok(
  "two receipts naming the same invoices in opposite order lock identically",
  JSON.stringify(orderedUniqueIds([7, 3])) ===
    JSON.stringify(orderedUniqueIds([3, 7]))
);
ok(
  "duplicates are locked once",
  JSON.stringify(orderedUniqueIds([4, 4, 1])) === "[1,4]"
);
ok(
  "ids sort numerically, not lexically",
  JSON.stringify(orderedUniqueIds([10, 9])) === "[9,10]"
);

// ── wiring ────────────────────────────────────────────────────────────────
{
  const integrity = read("./billing-receipt-issuance-integrity.ts");
  ok(
    "the lock statement orders by id and takes row locks",
    /ORDER BY "id"\s*\n\s*FOR UPDATE/.test(integrity)
  );
  ok(
    "the lock is tenant-scoped",
    /WHERE "businessId" = \$\{businessId\}/.test(integrity)
  );
  const lockAt = integrity.indexOf("await lockBillingDocumentRowsTx(");
  const aggAt = integrity.indexOf("billingPaymentAllocation.aggregate(");
  ok(
    "invoice capacity is read only after the invoices are locked",
    lockAt > 0 && aggAt > lockAt
  );
  ok(
    "capacity counts only authoritative (ISSUED) allocations",
    /authoritativeAllocationWhere\(args\.businessId\)/.test(integrity)
  );
  ok(
    "the equality rule runs before capacity",
    integrity.indexOf("assertReceiptAllocationsMatchTotal(") > 0 &&
      integrity.indexOf("assertReceiptAllocationsMatchTotal(") < lockAt
  );
}
{
  const issue = read("../billing-issue.service.ts");
  const txAt = issue.indexOf("billingTenantTx(input.businessId, async (tx) =>");
  const lockAt = issue.indexOf("await lockBillingDocumentRowsTx(tx,");
  const readAt = issue.indexOf("tx.billingDocument.findFirst({", txAt);
  const checkAt = issue.indexOf("await assertReceiptAllocationIntegrityTx(tx,");
  const issuedAt = issue.indexOf('intent: "issue_to_issued"');
  ok(
    "issuance locks the document inside its transaction, before reading it",
    txAt > 0 && lockAt > txAt && readAt > lockAt
  );
  ok(
    "issuance runs the integrity check inside the same transaction",
    checkAt > txAt
  );
  ok(
    "the check precedes the transition to ISSUED",
    checkAt > 0 && issuedAt > checkAt
  );
}
{
  const write = read("./billing-payment-allocation.service.ts");
  ok(
    "the draft preflight counts only authoritative allocations (drafts reserve nothing)",
    /authoritativeAllocationWhere\(input\.businessId\)/.test(write)
  );
  ok(
    "allocating a receipt takes the receipt's lock",
    /lockBillingDocumentRowsTx\(tx, input\.businessId, \[\s*input\.receiptDocumentId/.test(
      write
    )
  );
  ok(
    "issued receipts stay immutable",
    /assertBillingDocumentLinesMutable\(receipt\.status\)/.test(write)
  );
}
{
  const draft = read("./billing-receipt-draft.service.ts");
  ok(
    "replacing a receipt's payment lines takes the receipt's lock",
    /lockBillingDocumentRowsTx\(tx, input\.businessId, \[\s*input\.billingDocumentId/.test(
      draft
    )
  );
}

console.log(
  `\nbilling-receipt-issuance-integrity: ${pass} passed, ${failures.length} failed`
);
if (failures.length > 0) {
  console.log("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
assert.equal(failures.length, 0);
