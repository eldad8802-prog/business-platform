/**
 * Payables Phase 2 — reconciliation, proven against a real database.
 *
 * The rules in `payables-matching.test.ts` are pure and already proven. What
 * needs a database is the part a pure test cannot reach: that the ledger does
 * not double-count, in BOTH directions, and that the guard holds even when the
 * application logic is bypassed entirely.
 *
 * Run (CI provides an ephemeral postgres:17 service):
 *   TEST_DATABASE_URL="postgres://…" npx tsx lib/services/payables/payables-2.db.test.ts
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL.",
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
if (!process.env.AUTH_TOKEN_SECRET?.trim()) {
  process.env.AUTH_TOKEN_SECRET = "payables-p2-test-secret";
}

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
async function rejects(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  total += 1;
  try {
    await fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a rejection, none thrown`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok = !expect || expect.test(msg);
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — wrong error: ${msg}`}`);
  }
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const svc = await import("@/lib/services/payables/payables.service");
  const recon = await import("@/lib/services/payables/payables-reconciliation.service");

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAllocation_active_payment_installment_key"
      ON "PaymentAllocation"("paymentId", "installmentId") WHERE "reversedAt" IS NULL`);
  // The Phase 2 guard. `db push` cannot express it, so the suite creates the
  // same object the migration ships — otherwise the checks below would pass
  // vacuously against a database that has no guard at all.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvidence_active_document_key"
      ON "PaymentEvidence"("businessId", "documentId")
      WHERE "revokedAt" IS NULL AND "documentId" IS NOT NULL`);

  async function makeBusiness(label: string): Promise<number> {
    const b = await prisma.business.create({
      data: {
        name: `P2 ${label} ${runId}`,
        users: {
          create: {
            email: `p2-${label}-${runId}@example.test`,
            password: "test-password",
            name: "P2 Test User",
          },
        },
      },
    });
    return b.id;
  }

  async function makeDocument(
    businessId: number,
    opts: { amount: number; date: Date; vendorName: string; direction?: string },
  ): Promise<number> {
    const doc = await prisma.document.create({
      data: {
        businessId,
        fileUrl: `qa://p2/${runId}/${Math.random().toString(16).slice(2)}`,
        source: "qa",
        mimeType: "application/pdf",
        status: "APPROVED",
      },
    });
    await prisma.financialRecord.create({
      data: {
        documentId: doc.id,
        businessId,
        amount: opts.amount,
        date: opts.date,
        vendorName: opts.vendorName,
        direction: opts.direction ?? "expense",
        category: "utilities",
      },
    });
    return doc.id;
  }

  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B }, fn);
  const due = (iso: string) => new Date(iso);

  const payee = await asA(() =>
    svc.createPayee({ businessId: A, displayName: "עיריית תל אביב", kind: "AUTHORITY" }),
  );

  /* ── 1. THE ARNONA SCENARIO — payment first, receipt later ─────────────── */
  console.log("\n[1] arnona: payment first, receipt later");

  const arnona = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "ארנונה 2027",
      payeeId: payee.id,
      scheduleKind: "INSTALLMENT_PLAN",
      totalAmount: "7200.00",
      installmentCount: 6,
      recurrence: "MONTHLY",
      firstDueAt: due("2027-01-15T09:00:00.000Z"),
    }),
  );
  const instRows = await asA(() =>
    prisma.installment.findMany({
      where: { commitmentId: arnona.id },
      orderBy: { sequence: "asc" },
    }),
  );

  const paid = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "1200.00",
      paidAt: due("2027-01-16T09:00:00.000Z"),
      method: "BANK_TRANSFER",
      installmentIds: [instRows[0].id],
    }),
  );

  const balanceBefore = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }),
  );
  check("1. the payment counts once", balanceBefore.paid === "1200.00");

  // The receipt arrives later.
  const receipt = await makeDocument(A, {
    amount: 1200,
    date: due("2027-01-16T00:00:00.000Z"),
    vendorName: "עיריית תל אביב",
  });

  const suggestion = await asA(() =>
    recon.suggestMatchesForDocument({ businessId: A, documentId: receipt }),
  );
  check("1. the existing payment is suggested", suggestion.candidates.length > 0);
  const top = suggestion.candidates[0];
  check("1. and it is the PAYMENT, not a fresh instalment", top.target.kind === "PAYMENT");
  check("1. with the amount signal", top.signals.includes("AMOUNT"));
  check("1. and corroboration beyond the amount", top.signals.length > 1);
  check("1. presented as STRONG, never as certain", top.confidence === "STRONG");
  check("1. nothing is attached yet", suggestion.attachedTo === null);

  // The owner confirms.
  await asA(() =>
    recon.attachDocumentEvidence({
      businessId: A,
      documentId: receipt,
      paymentId: paid.payment.id,
    }),
  );

  const balanceAfter = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }),
  );
  check(
    "1. THE INVARIANT — confirming evidence does not move money",
    balanceAfter.paid === balanceBefore.paid,
    `${balanceBefore.paid} → ${balanceAfter.paid}`,
  );
  const paymentCount = await asA(() =>
    prisma.payment.count({ where: { businessId: A } }),
  );
  check("1. and creates NO second payment", paymentCount === 1, `found ${paymentCount}`);

  const evidences = await asA(() =>
    prisma.paymentEvidence.findMany({
      where: { businessId: A, paymentId: paid.payment.id },
      orderBy: { id: "asc" },
    }),
  );
  check(
    "1. the payment now carries MANUAL and DOCUMENT evidence",
    evidences.some((e) => e.kind === "MANUAL") && evidences.some((e) => e.kind === "DOCUMENT"),
    evidences.map((e) => e.kind).join(","),
  );
  check(
    "1. with ONE economic amount counted",
    balanceAfter.paid === "1200.00",
  );

  /* ── 2. the same receipt cannot also mint a payment ────────────────────── */
  console.log("\n[2] a receipt already used as evidence cannot become a payment");

  await rejects(
    "2. recording a payment from an already-attached document is refused",
    () =>
      asA(() =>
        recon.recordPaymentFromDocument({
          businessId: A,
          documentId: receipt,
          commitmentId: arnona.id,
          method: "BANK_TRANSFER",
        }),
      ),
    /already evidences|count the same money twice/i,
  );

  await rejects(
    "2. and attaching it to a DIFFERENT payment is refused",
    () =>
      asA(async () => {
        const other = await svc.recordManualPayment({
          businessId: A,
          commitmentId: arnona.id,
          amount: "1200.00",
          paidAt: due("2027-02-16T09:00:00.000Z"),
          method: "CASH",
          installmentIds: [instRows[1].id],
        });
        return recon.attachDocumentEvidence({
          businessId: A,
          documentId: receipt,
          paymentId: other.payment.id,
        });
      }),
    /already attached/i,
  );

  // The database refuses too, even with the service bypassed entirely.
  await rejects(
    "2. the DB itself refuses a second active evidence row",
    () =>
      asA(() =>
        prisma.paymentEvidence.create({
          data: {
            businessId: A,
            paymentId: paid.payment.id,
            kind: "DOCUMENT",
            documentId: receipt,
          },
        }),
      ),
    /unique|constraint/i,
  );

  /* ── 3. receipt first — a score creates nothing ────────────────────────── */
  console.log("\n[3] receipt first: a high score creates nothing on its own");

  const unpaidDoc = await makeDocument(A, {
    amount: 1200,
    date: due("2027-03-15T00:00:00.000Z"),
    vendorName: "עיריית תל אביב",
  });

  const before = await asA(() => prisma.payment.count({ where: { businessId: A } }));
  const s2 = await asA(() =>
    recon.suggestMatchesForDocument({ businessId: A, documentId: unpaidDoc }),
  );
  const after = await asA(() => prisma.payment.count({ where: { businessId: A } }));
  check("3. suggesting is pure — no payment appears", before === after, `${before} → ${after}`);
  check("3. candidates were found", s2.candidates.length > 0);
  check(
    "3. and the top one scores well without having decided anything",
    s2.candidates[0].score > 0.5,
  );

  // Only the owner's decision creates the economic event.
  const created = await asA(() =>
    recon.recordPaymentFromDocument({
      businessId: A,
      documentId: unpaidDoc,
      commitmentId: arnona.id,
      installmentIds: [instRows[2].id],
      method: "BANK_TRANSFER",
    }),
  );
  const afterConfirm = await asA(() =>
    prisma.payment.count({ where: { businessId: A } }),
  );
  check("3. confirming DOES create exactly one payment", afterConfirm === after + 1);
  check(
    "3. for the document's amount, through the minor-unit boundary",
    created.payment.amount.toString() === "1200",
    created.payment.amount.toString(),
  );
  check(
    "3. and the new payment carries its document evidence from birth",
    created.evidence.documentId === unpaidDoc,
  );

  /* ── 4. rejection sticks, and is scoped to the pairing ─────────────────── */
  console.log("\n[4] rejection");

  const looseDoc = await makeDocument(A, {
    amount: 1200,
    date: due("2027-04-15T00:00:00.000Z"),
    vendorName: "עיריית תל אביב",
  });
  const beforeReject = await asA(() =>
    recon.suggestMatchesForDocument({ businessId: A, documentId: looseDoc }),
  );
  const rejectTarget = beforeReject.candidates.find((c) => c.target.kind === "INSTALLMENT");
  check("4. there is an instalment candidate to reject", rejectTarget !== undefined);

  if (rejectTarget && rejectTarget.target.kind === "INSTALLMENT") {
    await asA(() =>
      recon.rejectMatch({
        businessId: A,
        documentId: looseDoc,
        commitmentId: rejectTarget.target.commitmentId,
        installmentId: rejectTarget.target.installmentId,
        reason: "לא זה",
      }),
    );
    const afterReject = await asA(() =>
      recon.suggestMatchesForDocument({ businessId: A, documentId: looseDoc }),
    );
    const stillThere = afterReject.candidates.some(
      (c) =>
        c.target.kind === "INSTALLMENT" &&
        c.target.installmentId === rejectTarget.target.installmentId,
    );
    check("4. the rejected pairing stops being suggested", !stillThere);
    check(
      "4. but other candidates survive — a rejection is not a blanket dismissal",
      afterReject.candidates.length > 0,
    );

    // Re-rejecting is the same decision, not a duplicate row.
    await asA(() =>
      recon.rejectMatch({
        businessId: A,
        documentId: looseDoc,
        commitmentId: rejectTarget.target.commitmentId,
        installmentId: rejectTarget.target.installmentId,
      }),
    );
    const rejectionCount = await asA(() =>
      prisma.payablesMatchRejection.count({
        where: { businessId: A, documentId: looseDoc },
      }),
    );
    check("4. re-rejecting does not duplicate", rejectionCount === 1, `${rejectionCount}`);
  }

  /* ── 5. revocation is reversible and audited ───────────────────────────── */
  console.log("\n[5] revocation");

  const evidenceRow = await asA(() =>
    prisma.paymentEvidence.findFirst({
      where: { businessId: A, documentId: receipt, revokedAt: null },
    }),
  );
  check("5. the attachment exists", evidenceRow !== null);

  if (evidenceRow) {
    await asA(() =>
      recon.revokeDocumentEvidence({
        businessId: A,
        evidenceId: evidenceRow.id,
        reason: "שויך למסמך הלא נכון",
      }),
    );
    const revoked = await asA(() =>
      prisma.paymentEvidence.findFirst({ where: { id: evidenceRow.id } }),
    );
    check("5. the row is KEPT, not deleted", revoked !== null);
    check("5. and stamped", revoked?.revokedAt !== null);
    check("5. carrying its reason", revoked?.revocationReason === "שויך למסמך הלא נכון");

    const balanceAfterRevoke = await asA(() =>
      svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }),
    );
    check(
      "5. revoking evidence does not move money either",
      balanceAfterRevoke.paid === "3600.00",
      balanceAfterRevoke.paid,
    );

    // The door opens again — the whole reason the index is partial.
    const reattached = await asA(() =>
      recon.attachDocumentEvidence({
        businessId: A,
        documentId: receipt,
        paymentId: paid.payment.id,
      }),
    );
    check("5. the document can be re-attached after revocation", reattached.id !== evidenceRow.id);
  }

  /* ── 6. audit and tenant isolation ─────────────────────────────────────── */
  console.log("\n[6] audit and tenant isolation");

  const audit = await asA(() =>
    prisma.payablesAuditEvent.findMany({
      where: { businessId: A, eventType: { startsWith: "DOCUMENT_" } },
    }),
  );
  check("6. reconciliation decisions are audited", audit.length >= 3, `${audit.length} events`);
  check("6. every one carries a hash", audit.every((e) => e.eventHash.length === 64));
  check(
    "6. attachment, rejection and revocation are all represented",
    ["DOCUMENT_EVIDENCE_ATTACHED", "DOCUMENT_MATCH_REJECTED", "DOCUMENT_EVIDENCE_REVOKED"].every(
      (t) => audit.some((e) => e.eventType === t),
    ),
  );

  await rejects(
    "6. B cannot suggest against A's document",
    () => asB(() => recon.suggestMatchesForDocument({ businessId: B, documentId: receipt })),
    /not found|no approved/i,
  );
  await rejects(
    "6. B cannot attach A's document to anything",
    () =>
      asB(() =>
        recon.attachDocumentEvidence({
          businessId: B,
          documentId: receipt,
          paymentId: paid.payment.id,
        }),
      ),
    /not found/i,
  );

  const bDoc = await makeDocument(B, {
    amount: 1200,
    date: due("2027-01-16T00:00:00.000Z"),
    vendorName: "עיריית תל אביב",
  });
  const bSuggestions = await asB(() =>
    recon.suggestMatchesForDocument({ businessId: B, documentId: bDoc }),
  );
  check(
    "6. B's identical document finds NONE of A's commitments",
    bSuggestions.candidates.length === 0,
    `saw ${bSuggestions.candidates.length}`,
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("DB suite crashed:", err);
  process.exit(1);
});
