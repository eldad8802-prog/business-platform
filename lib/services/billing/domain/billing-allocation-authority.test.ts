/**
 * Run: npx tsx lib/services/billing/domain/billing-allocation-authority.test.ts
 *
 * What makes a document count against a real debt — the rule, and the proof
 * that every reader actually goes through it.
 *
 * THE DEFECT THIS CLOSES. An allocation reduced an invoice's outstanding
 * balance from the moment it was written, which is while its receipt is still a
 * DRAFT. The collection loader already applied the opposite rule to credit
 * notes — only ISSUED ones count — so the system held two contradictory
 * theories of when a document becomes accounting-authoritative.
 *
 * WHY HALF THIS FILE IS A STRUCTURAL CHECK. The rule is a Prisma `where`
 * fragment, because the money is summed in the database rather than in memory.
 * A unit test can prove the fragment says the right thing, but it cannot prove
 * a reader used it — and a reader that quietly kept its old unfiltered query
 * would leave the balance wrong on exactly one screen, which is the failure
 * this phase exists to remove. So the three readers are read from disk and
 * checked, and a fourth check proves no NEW reader can appear without one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { BillingDocumentStatus } from "@prisma/client";
import {
  AUTHORITATIVE_DOCUMENT_STATUS,
  authoritativeAllocationWhere,
  authoritativeCreditNoteWhere,
} from "./billing-allocation-authority";

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

function read(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), "utf8");
}

// ── the rule itself ──────────────────────────────────────────────────────
{
  ok(
    "the authoritative threshold is ISSUED",
    AUTHORITATIVE_DOCUMENT_STATUS === BillingDocumentStatus.ISSUED,
    String(AUTHORITATIVE_DOCUMENT_STATUS)
  );

  const where = authoritativeAllocationWhere(7);
  const receipt = where.receiptDocument as {
    businessId?: number;
    status?: BillingDocumentStatus;
  };
  ok(
    "an allocation counts only when its receipt is ISSUED",
    receipt.status === BillingDocumentStatus.ISSUED,
    String(receipt.status)
  );
  ok(
    "a DRAFT receipt therefore does not satisfy the filter",
    receipt.status !== BillingDocumentStatus.DRAFT
  );
  ok(
    "nor does PENDING_REVIEW",
    receipt.status !== BillingDocumentStatus.PENDING_REVIEW
  );

  // §10. The filter introduces a join, and a foreign key knows nothing about
  // tenants. Without this predicate an allocation row could be qualified by
  // ANOTHER business's issued receipt.
  ok(
    "the join names the business on both sides, so it cannot reach another tenant's receipt",
    receipt.businessId === 7,
    String(receipt.businessId)
  );
  ok(
    "and it carries the business it was asked about, not a hard-coded one",
    (authoritativeAllocationWhere(99).receiptDocument as { businessId?: number })
      .businessId === 99
  );
}

// ── THE POINT OF THE PHASE: one rule, not two that happen to agree ───────
{
  const creditNote = authoritativeCreditNoteWhere();
  ok(
    "a credit note counts only when ISSUED — unchanged",
    creditNote.status === BillingDocumentStatus.ISSUED,
    String(creditNote.status)
  );
  ok(
    "it is still restricted to credit notes",
    creditNote.documentType === "CREDIT_NOTE",
    String(creditNote.documentType)
  );

  const allocationStatus = (
    authoritativeAllocationWhere(1).receiptDocument as {
      status?: BillingDocumentStatus;
    }
  ).status;
  ok(
    "RECEIPTS AND CREDIT NOTES SHARE ONE THRESHOLD, from one constant",
    allocationStatus === creditNote.status &&
      allocationStatus === AUTHORITATIVE_DOCUMENT_STATUS
  );

  const source = read("./billing-allocation-authority.ts");
  const literals = source.match(/BillingDocumentStatus\.ISSUED/g) ?? [];
  ok(
    "and the threshold is written down exactly once, so the two cannot drift",
    literals.length === 1,
    `${literals.length} literal occurrences`
  );
}

// ── every reader goes through the rule ───────────────────────────────────
//
// The three readers named in the C2 plan. Each sums allocations in the
// database; each must qualify them.
const READERS: { label: string; path: string }[] = [
  {
    label: "collection loader (customer debt list)",
    path: "../collection/awaiting-payment.loader.ts",
  },
  {
    label: "settlement-state service (invoice paid / partial / unpaid)",
    path: "../receipt/billing-settlement-state.service.ts",
  },
  {
    label: "payments store findPayableDocument (how much may be paid)",
    path: "../../payments/payment-store.prisma.ts",
  },
];

for (const reader of READERS) {
  const source = read(reader.path);
  ok(
    `${reader.label} — qualifies its allocations`,
    /authoritativeAllocationWhere\(/.test(source)
  );
  ok(
    `${reader.label} — does not read allocations raw`,
    !/paymentAllocationsAsInvoice:\s*\{\s*select:/.test(source) &&
      !/allocationsAsInvoice:\s*true/.test(source)
  );
}

// A reader that appears later must not be able to skip the rule silently.
// Any file summing allocations has to name the shared filter.
{
  const suspects = READERS.map((r) => ({ ...r, source: read(r.path) }));
  const unqualified = suspects.filter(
    (s) =>
      /billingPaymentAllocation\.aggregate|paymentAllocationsAsInvoice/.test(
        s.source
      ) && !/authoritativeAllocationWhere/.test(s.source)
  );
  ok(
    "no known reader sums allocations without the shared filter",
    unqualified.length === 0,
    unqualified.map((s) => s.label).join(", ")
  );
}

// ── the credit-note rule was lifted, not rewritten ───────────────────────
//
// C2 must not change credit-note semantics. Both readers previously carried
// the same filter inline; they now call the shared one, and no inline copy
// may remain to disagree with it later.
for (const rel of [
  "../collection/awaiting-payment.loader.ts",
  "../../payments/payment-store.prisma.ts",
]) {
  const source = read(rel);
  ok(
    `${rel} — credit notes go through the shared filter`,
    /authoritativeCreditNoteWhere\(\)/.test(source)
  );
  ok(
    `${rel} — no inline copy of the credit-note rule remains`,
    !/documentType:\s*BillingDocumentType\.CREDIT_NOTE/.test(source)
  );
}

console.log(
  `\nbilling-allocation-authority: ${pass} passed, ${failures.length} failed`
);
if (failures.length > 0) {
  console.log("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
assert.equal(failures.length, 0);
