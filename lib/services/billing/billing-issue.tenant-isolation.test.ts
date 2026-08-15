/**
 * Tenant-ownership regression guard for the most critical billing operation:
 * issuing a document (`issueBillingDocument`, exposed at
 * `POST /api/billing/documents/[id]/issue`).
 *
 * Locks the already-proven invariant (static review found NO gap):
 *   A user of Business A cannot ISSUE a document that belongs to Business B,
 *   even knowing its documentId — the attempt is rejected BEFORE any side
 *   effect (no legal number, no lock, no authority submission, no audit event,
 *   no sequence advance).
 *
 * This is a DB-backed, two-tenant integration test (same pattern as
 * lib/services/crm/crm-notes.service.test.ts). It seeds and deletes REAL rows,
 * so it is fail-closed behind an explicit test-DB authorization (see the
 * Database Safety Guard below) and is a manual / local check — CI does not run
 * a database. No production code is changed; the service's existing authority
 * dependency-injection seam is used to keep the run hermetic (no network).
 *
 * Run:
 *   TEST_DATABASE_URL="postgres://…<approved dev/test DB>…" \
 *     npx tsx lib/services/billing/billing-issue.tenant-isolation.test.ts
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — MUST run before any DB import/connect.
//
// The test performs destructive writes (seed + deleteMany). To make an
// accidental production DATABASE_URL impossible to hit, we refuse to run unless
// the operator explicitly names an approved test/dev database in
// TEST_DATABASE_URL, and we force the Prisma singleton to use exactly that URL.
// The ambient DATABASE_URL is never used unless it was explicitly re-affirmed
// as the test target. No approved target proven → abort with zero data change.
// ---------------------------------------------------------------------------
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test/dev Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL."
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB; // the Prisma singleton (imported dynamically below) binds to this.
if (!process.env.AUTH_TOKEN_SECRET?.trim()) {
  process.env.AUTH_TOKEN_SECRET = "billing-issue-tenant-iso-test-secret";
}

import assert from "node:assert/strict";
import { BillingDocumentStatus, BillingDocumentType, Prisma } from "@prisma/client";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function main(): Promise<void> {
  // Dynamic imports AFTER the guard, so the Prisma client constructs against TEST_DATABASE_URL.
  const { prisma } = await import("@/lib/prisma");
  const { issueBillingDocument } = await import(
    "@/lib/services/billing/billing-issue.service"
  );
  const { recomputeAll } = await import(
    "@/lib/services/billing/totals/billing-totals.service"
  );
  const { NotFoundError } = await import("@/lib/errors");

  // Warm the connection/planner so the service's 5s interactive-transaction
  // budget (unchanged; a production default) is spent on work, not cold-start
  // latency to the remote dev DB.
  await prisma.$queryRawUnsafe("SELECT 1").catch(() => {});

  // The issue path runs a heavy multi-statement interactive transaction with a
  // fixed 5s budget. Against a remote dev DB this can occasionally exceed the
  // budget purely on network latency (rolled back cleanly). Retry ONLY the
  // owner-issuance positive control, ONLY on that infra timeout — never on the
  // cross-tenant subject, which stays a single deterministic call.
  function isTxTimeoutFlake(e: unknown): boolean {
    const err = e as { code?: string; message?: string };
    return (
      err?.code === "P2028" ||
      /Transaction (already closed|not found)|expired transaction|interactive transaction timeout/i.test(
        err?.message ?? ""
      )
    );
  }
  async function issueWithInfraRetry(
    input: { businessId: number; actorUserId: number; billingDocumentId: number },
    attempts = 3
  ) {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await issueBillingDocument(input, authorityDeps);
      } catch (e) {
        if (isTxTimeoutFlake(e)) {
          lastErr = e;
          console.warn(`positive-control issue infra timeout (attempt ${i + 1}/${attempts}) — retrying`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  const businessIds: number[] = [];
  const documentIds: number[] = [];

  // Hermetic authority: the service resolves the external Approval call via this
  // injected dep. A small invoice below the allocation threshold resolves to
  // NOT_REQUIRED, so this is not called — we assert it stays uncalled on the
  // rejected (cross-tenant) path.
  const authoritySpy = { calls: 0 };
  const authorityDeps = {
    executeApproval: async (input: {
      businessId: number;
      billingDocumentId: number;
      actorUserId: number;
    }) => {
      authoritySpy.calls += 1;
      return {
        outcome: "in_progress" as const,
        billingDocumentId: input.billingDocumentId,
        submissionId: 0,
        safeToRetry: false as const,
      };
    },
  };

  async function seedTenant(label: string) {
    const b = await prisma.business.create({
      data: { name: `TenantIso ${label} ${runId}` },
    });
    businessIds.push(b.id);
    // Billing identity ready for TAX_INVOICE issuance (required for positive control).
    await prisma.businessProfile.create({
      data: {
        businessId: b.id,
        billingLegalName: `Legal ${label} ${runId}`,
        billingBusinessKind: "LTD_COMPANY",
        billingTaxId: "123456782",
        billingAddress: "Rehov HaBdika 1, Tel Aviv",
        billingPhone: "03-0000000",
        billingEmail: `iso-${label}-${runId}@example.test`,
      },
    });
    const u = await prisma.user.create({
      data: {
        businessId: b.id,
        email: `iso-user-${label}-${runId}@example.test`,
        password: "x",
        name: `User ${label}`,
      },
    });
    return { businessId: b.id, userId: u.id };
  }

  // A genuinely issuable DRAFT TAX_INVOICE with one line and consistent totals.
  async function seedIssuableInvoice(businessId: number) {
    const parsed = [
      {
        description: "Item",
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(100),
        vatRatePercent: new Prisma.Decimal(17),
        lineIndex: 0,
      },
    ];
    const { lines, totals } = recomputeAll(parsed);
    const doc = await prisma.billingDocument.create({
      data: {
        businessId,
        documentType: BillingDocumentType.TAX_INVOICE,
        status: BillingDocumentStatus.DRAFT,
        currency: "ILS",
        customerNameSnapshot: "Customer Test",
        subtotalAmount: totals.subtotalAmount,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
      },
    });
    documentIds.push(doc.id);
    await prisma.billingDocumentLine.create({
      data: {
        billingDocumentId: doc.id,
        lineIndex: 0,
        description: "Item",
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(100),
        vatRatePercent: new Prisma.Decimal(17),
        lineSubtotal: lines[0].lineSubtotal,
        vatAmount: lines[0].vatAmount,
        lineTotal: lines[0].lineTotal,
      },
    });
    return doc;
  }

  async function sequenceNumber(businessId: number): Promise<number | null> {
    const seq = await prisma.billingDocumentNumberSequence.findUnique({
      where: {
        businessId_documentType: {
          businessId,
          documentType: BillingDocumentType.TAX_INVOICE,
        },
      },
      select: { nextNumber: true },
    });
    return seq?.nextNumber ?? null;
  }

  try {
    const A = await seedTenant("A");
    const B = await seedTenant("B");
    // Two identical issuable invoices for B: one for the cross-tenant attempt,
    // one for the positive control. Identical construction => a rejection on the
    // first can only be due to the businessId mismatch.
    const docNeg = await seedIssuableInvoice(B.businessId);
    const docPos = await seedIssuableInvoice(B.businessId);

    const seqABefore = await sequenceNumber(A.businessId);
    const seqBBefore = await sequenceNumber(B.businessId);
    assert.equal(seqABefore, null, "precondition: A has no invoice sequence yet");
    assert.equal(seqBBefore, null, "precondition: B has no invoice sequence yet");

    // ============================ NEGATIVE (subject) ============================
    // Business A tries to ISSUE Business B's document.
    let thrown: unknown = null;
    try {
      await issueBillingDocument(
        {
          businessId: A.businessId,
          actorUserId: A.userId,
          billingDocumentId: docNeg.id,
        },
        authorityDeps
      );
    } catch (e) {
      thrown = e;
    }

    // #1 — rejected with the canonical not-owned behavior.
    assert.ok(
      thrown instanceof NotFoundError,
      `cross-tenant issue must be rejected with NotFoundError (got: ${
        thrown instanceof Error ? thrown.constructor.name + ": " + thrown.message : String(thrown)
      })`
    );

    // Absence of ALL issuance side effects on B's document (the real proof):
    const after = await prisma.billingDocument.findUniqueOrThrow({
      where: { id: docNeg.id },
    });
    // #2 — document unchanged (still a DRAFT with no issuance artifacts).
    assert.equal(after.status, BillingDocumentStatus.DRAFT, "docNeg stays DRAFT");
    assert.equal(after.documentNumber, null, "docNeg has NO legal number");
    assert.equal(after.documentNumberFormatted, null, "docNeg has no formatted number");
    assert.equal(after.issuedAt, null, "docNeg has no issuedAt");
    assert.equal(after.lockedAt, null, "docNeg is not locked");
    assert.equal(after.legalSnapshotHash, null, "docNeg has no legal snapshot hash");

    // #3 / #4 — neither tenant's numbering sequence advanced.
    assert.equal(await sequenceNumber(A.businessId), null, "A sequence unchanged (none)");
    assert.equal(await sequenceNumber(B.businessId), null, "B sequence unchanged (none)");

    // #5 — no authority submission created, and the authority path never ran.
    const sub = await prisma.billingAuthoritySubmission.findUnique({
      where: { billingDocumentId: docNeg.id },
      select: { id: true },
    });
    assert.equal(sub, null, "no BillingAuthoritySubmission for docNeg");
    assert.equal(authoritySpy.calls, 0, "authority stub was NOT invoked on the rejected path");

    // #6 — no issuance audit event for docNeg.
    const auditCount = await prisma.billingAuditEvent.count({
      where: { billingDocumentId: docNeg.id },
    });
    assert.equal(auditCount, 0, "no BillingAuditEvent for docNeg");

    console.log("OK negative: cross-tenant issue rejected with zero side effects.");

    // ===================== POSITIVE CONTROL (anti-vacuity) =====================
    // The SAME construction, issued by its true owner (B), MUST succeed — proving
    // docNeg was genuinely issuable and the rejection above was purely the tenant
    // mismatch, not an unrelated defect.
    const okResult = await issueWithInfraRetry({
      businessId: B.businessId,
      actorUserId: B.userId,
      billingDocumentId: docPos.id,
    });
    // #7 — owner issuance succeeds (ISSUED + a legal number assigned).
    assert.equal(okResult.document.status, BillingDocumentStatus.ISSUED, "owner issue → ISSUED");
    assert.ok(
      typeof okResult.document.documentNumber === "number" && okResult.document.documentNumber > 0,
      "owner issue assigned a positive legal number"
    );

    console.log("OK positive control: same fixture issues successfully for its owner (B).");
    console.log("PASS — billing issue tenant-ownership regression guard.");
  } finally {
    // Self-cleaning (children → parents), scoped to this run's tenants only.
    if (businessIds.length > 0) {
      const where = { businessId: { in: businessIds } };
      await prisma.learningEvent.deleteMany({ where }).catch(() => {});
      await prisma.financialEvent.deleteMany({ where }).catch(() => {});
      await prisma.billingAuthoritySubmission.deleteMany({ where }).catch(() => {});
      await prisma.billingAuditEvent.deleteMany({ where }).catch(() => {});
      if (documentIds.length > 0) {
        await prisma.billingDocumentLine
          .deleteMany({ where: { billingDocumentId: { in: documentIds } } })
          .catch(() => {});
      }
      await prisma.billingDocument.deleteMany({ where }).catch(() => {});
      await prisma.billingDocumentNumberSequence.deleteMany({ where }).catch(() => {});
      await prisma.businessProfile.deleteMany({ where }).catch(() => {});
      await prisma.user.deleteMany({ where }).catch(() => {});
      await prisma.business.deleteMany({ where: { id: { in: businessIds } } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error("FAIL —", e);
  process.exit(1);
});
