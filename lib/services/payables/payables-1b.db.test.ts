/**
 * Payables Phase 1b — DB-backed proofs for the read side and for editing.
 *
 * The 1a suite proves the ledger is correct. This one proves the SCREEN cannot
 * disagree with it: that a list and a detail derive the same balances from the
 * same rows, that one payment spread over four instalments is presented as one
 * economic event, that a legacy assertion is never counted as paid, and that
 * editing a commitment cannot quietly change what is owed.
 *
 * Run (CI provides an ephemeral postgres:17 service):
 *   TEST_DATABASE_URL="postgres://…" npx tsx lib/services/payables/payables-1b.db.test.ts
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — MUST run before any DB import/connect.
// ---------------------------------------------------------------------------
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
  process.env.AUTH_TOKEN_SECRET = "payables-p1b-test-secret";
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
  const read = await import("@/lib/services/payables/payables-read");

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAllocation_active_payment_installment_key"
      ON "PaymentAllocation"("paymentId", "installmentId")
      WHERE "reversedAt" IS NULL
  `);

  async function makeBusiness(label: string): Promise<number> {
    const b = await prisma.business.create({
      data: {
        name: `P1b ${label} ${runId}`,
        users: {
          create: {
            email: `p1b-${label}-${runId}@example.test`,
            password: "test-password",
            name: "P1b Test User",
          },
        },
      },
    });
    return b.id;
  }

  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B }, fn);
  const due = (iso: string) => new Date(iso);

  const payee = await asA(() =>
    svc.createPayee({ businessId: A, displayName: "עיריית חיפה", kind: "AUTHORITY" }),
  );

  /* ── 1. list and detail derive the SAME figures ─────────────────────────── */
  console.log("\n[1] the list cannot disagree with the detail");

  const arnona = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "ארנונה",
      payeeId: payee.id,
      scheduleKind: "INSTALLMENT_PLAN",
      totalAmount: "1200.00",
      installmentCount: 4,
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

  await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "300.00",
      paidAt: due("2027-01-16T09:00:00.000Z"),
      method: "BANK_TRANSFER",
      installmentIds: [instRows[0].id],
    }),
  );

  const listed = await asA(() => read.listCommitments({ businessId: A, scope: "open" }));
  const row = listed.find((r) => r.id === arnona.id)!;
  const balance = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }),
  );
  const detail = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: arnona.id }),
  );

  check("1. list paid == service paid", row.paid === balance.paid, `${row.paid} vs ${balance.paid}`);
  check(
    "1. list remaining == service remaining",
    row.remaining === balance.remaining,
    `${row.remaining} vs ${balance.remaining}`,
  );
  check("1. detail paid == service paid", detail.paid === balance.paid);
  check("1. detail remaining == service remaining", detail.remaining === balance.remaining);
  check("1. the list reports the real installment count", row.installmentCount === 4);

  /* ── 2. one payment over many instalments is ONE economic event ─────────── */
  console.log("\n[2] one payment, four instalments, one row");

  const spread = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "פריסה",
      payeeId: payee.id,
      scheduleKind: "INSTALLMENT_PLAN",
      totalAmount: "400.00",
      installmentCount: 4,
      recurrence: "MONTHLY",
      firstDueAt: due("2027-02-01T09:00:00.000Z"),
    }),
  );
  const spreadRows = await asA(() =>
    prisma.installment.findMany({
      where: { commitmentId: spread.id },
      orderBy: { sequence: "asc" },
    }),
  );
  await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: spread.id,
      amount: "400.00",
      paidAt: due("2027-02-02T09:00:00.000Z"),
      method: "CASH",
      installmentIds: spreadRows.map((r) => r.id),
    }),
  );
  const spreadDetail = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: spread.id }),
  );
  check(
    "2. four allocations exist",
    spreadDetail.installments.reduce((s, i) => s + i.allocations.length, 0) === 4,
  );
  check("2. but only ONE payment row is presented", spreadDetail.payments.length === 1);
  check("2. for the full amount, counted once", spreadDetail.paid === "400.00");
  check("2. with nothing left unallocated", spreadDetail.payments[0].unallocated === "0.00");

  /* ── 3. a surplus is reported, never spread ─────────────────────────────── */
  console.log("\n[3] surplus");

  const small = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "אגרה",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "100.00",
      firstDueAt: due("2027-03-01T09:00:00.000Z"),
    }),
  );
  const over = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: small.id,
      amount: "150.00",
      paidAt: due("2027-03-02T09:00:00.000Z"),
      method: "CASH",
    }),
  );
  check("3. the surplus is reported back", over.unallocated === "50.00");
  const smallDetail = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: small.id }),
  );
  check("3. the installment is paid exactly once", smallDetail.paid === "100.00");
  check(
    "3. and the surplus is still visible on the payment",
    smallDetail.payments[0].unallocated === "50.00",
  );

  /* ── 4. a reversal returns the money to the payment, visibly ────────────── */
  console.log("\n[4] reversal is visible, not silent");

  const allocId = smallDetail.installments[0].allocations[0].id;
  await asA(() =>
    svc.reverseAllocation({ businessId: A, allocationId: allocId, reason: "שויך בטעות" }),
  );
  const afterReverse = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: small.id }),
  );
  check("4. nothing counts as paid now", afterReverse.paid === "0.00");
  check("4. the allocation row is KEPT", afterReverse.installments[0].allocations.length === 1);
  check("4. and marked inactive", afterReverse.installments[0].allocations[0].active === false);
  check(
    "4. carrying its reason",
    afterReverse.installments[0].allocations[0].reversalReason === "שויך בטעות",
  );
  check(
    "4. the whole payment is unallocated again",
    afterReverse.payments[0].unallocated === "150.00",
  );

  /* ── 5. a legacy assertion is never presented as paid ───────────────────── */
  console.log("\n[5] SETTLED_LEGACY is an assertion, not a payment");

  const legacyCommitment = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "ישן",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "900.00",
      firstDueAt: due("2026-01-01T09:00:00.000Z"),
    }),
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "Installment" SET "status" = 'SETTLED_LEGACY',
       "legacySettlementAssertedBy" = 'OWNER', "legacyMetAt" = NOW()
     WHERE "commitmentId" = ${legacyCommitment.id}`,
  );
  const legacyDetail = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: legacyCommitment.id }),
  );
  check("5. it contributes ZERO to paid", legacyDetail.paid === "0.00");
  check("5. its state is SETTLED_LEGACY", legacyDetail.installments[0].state === "SETTLED_LEGACY");
  check("5. no payment exists for it", legacyDetail.payments.length === 0);
  check("5. the provenance is surfaced", legacyDetail.legacy?.assertedBy === "OWNER");

  const legacyRow = (await asA(() =>
    read.listCommitments({ businessId: A, scope: "all" }),
  )).find((r) => r.id === legacyCommitment.id)!;
  check("5. and the list does not nag about it", legacyRow.attention === "SETTLED_LEGACY");

  /* ── 6. attention ordering puts overdue money first ─────────────────────── */
  console.log("\n[6] the list leads with what is late");

  const all = await asA(() => read.listCommitments({ businessId: A, scope: "all" }));
  const rank = all.map((r) => r.attention);
  const firstSettled = rank.findIndex((s) => s === "SETTLED_LEGACY" || s === "PAID");
  const lastUrgent = rank.reduce(
    (acc, s, i) => (s === "OVERDUE" || s === "DUE" ? i : acc),
    -1,
  );
  check(
    "6. nothing urgent sorts below something settled",
    firstSettled === -1 || lastUrgent < firstSettled,
    `urgent@${lastUrgent} settled@${firstSettled}`,
  );

  /* ── 7. editing changes the description, never the money ────────────────── */
  console.log("\n[7] edit");

  const before = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: arnona.id }),
  );
  const renamed = await asA(() =>
    svc.updateCommitment({
      businessId: A,
      commitmentId: arnona.id,
      title: "ארנונה 2027",
      note: "לפי שובר",
    }),
  );
  check("7. the title changed", renamed.title === "ארנונה 2027");
  const after = await asA(() =>
    read.getCommitmentDetail({ businessId: A, commitmentId: arnona.id }),
  );
  check("7. total is untouched", after.total === before.total);
  check("7. paid is untouched", after.paid === before.paid);
  check("7. remaining is untouched", after.remaining === before.remaining);
  check(
    "7. the installments are untouched",
    after.installments.length === before.installments.length,
  );
  check(
    "7. and the edit is audited",
    after.audit.some((a) => a.eventType === "COMMITMENT_UPDATED"),
  );

  await rejects(
    "7. detaching the payee without a name is refused",
    () =>
      asA(() =>
        svc.updateCommitment({
          businessId: A,
          commitmentId: arnona.id,
          payeeId: null,
          payeeNameSnapshot: "   ",
        }),
      ),
    /payee name is required/i,
  );

  /* ── 8. the read side is tenant-scoped ──────────────────────────────────── */
  console.log("\n[8] tenant isolation on the read path");

  const bList = await asB(() => read.listCommitments({ businessId: B, scope: "all" }));
  check("8. B sees none of A's commitments", bList.length === 0, `saw ${bList.length}`);

  await rejects(
    "8. B cannot open A's commitment by id",
    () => asB(() => read.getCommitmentDetail({ businessId: B, commitmentId: arnona.id })),
    /not found/i,
  );

  const payeeB = await asB(() =>
    svc.createPayee({ businessId: B, displayName: "ספק של B" }),
  );
  await rejects(
    "8. A cannot re-point its commitment at B's payee",
    () =>
      asA(() =>
        svc.updateCommitment({
          businessId: A,
          commitmentId: arnona.id,
          payeeId: payeeB.id,
        }),
      ),
    /Payee not found/i,
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("DB suite crashed:", err);
  process.exit(1);
});
