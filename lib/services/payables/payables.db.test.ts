/**
 * Payables Phase 1a — DB-backed proofs.
 *
 * Everything here is a property OF THE DATABASE and cannot be simulated in a
 * pure test: the partial unique index, tenant isolation, concurrent
 * over-allocation, idempotent retries, and the legacy backfill. The arithmetic
 * proofs live in `payables-core.test.ts` and need no database at all.
 *
 * Run (CI provides an ephemeral postgres:17 service):
 *   TEST_DATABASE_URL="postgres://…" npx tsx lib/services/payables/payables.db.test.ts
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — MUST run before any DB import/connect.
// This test seeds and deletes REAL rows. It refuses to run unless the operator
// explicitly names a test database, so an ambient production DATABASE_URL can
// never be reached by accident. Same guard as the billing tenant-isolation test.
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
  process.env.AUTH_TOKEN_SECRET = "payables-p1a-test-secret";
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
async function rejects(name: string, fn: () => Promise<unknown>, expect?: RegExp): Promise<void> {
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

  // `prisma db push` cannot create a partial unique index — it is not
  // expressible in the datamodel — so the index the migration ships is created
  // here explicitly. Without this, test N would pass vacuously.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAllocation_active_payment_installment_key"
      ON "PaymentAllocation"("paymentId", "installmentId")
      WHERE "reversedAt" IS NULL
  `);

  async function makeBusiness(label: string): Promise<number> {
    const b = await prisma.business.create({
      data: {
        name: `Payables ${label} ${runId}`,
        users: {
          create: {
            email: `payables-${label}-${runId}@example.test`,
            password: "test-password",
            name: "Payables Test User",
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

  /* ── A/B. commitment creation ───────────────────────────────────────────── */
  console.log("\n[A/B] commitment creation");
  const payee = await asA(() =>
    svc.createPayee({ businessId: A, displayName: "עיריית תל אביב", kind: "AUTHORITY" }),
  );
  check("a payee is created", payee.id > 0);

  const oneOff = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "אגרה חד פעמית",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "500.00",
      firstDueAt: due("2026-07-01T09:00:00.000Z"),
    }),
  );
  const oneOffRows = await asA(() =>
    prisma.installment.findMany({ where: { commitmentId: oneOff.id } }),
  );
  check("A. ONE_OFF creates exactly 1 installment", oneOffRows.length === 1);
  check("A. for the full amount", oneOffRows[0].scheduledAmount.toString() === "500");
  check("A. snapshot copied from the payee", oneOff.payeeNameSnapshot === "עיריית תל אביב");

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
  const arnonaRows = await asA(() =>
    prisma.installment.findMany({ where: { commitmentId: arnona.id }, orderBy: { sequence: "asc" } }),
  );
  check("B. INSTALLMENT_PLAN creates 6 installments", arnonaRows.length === 6);
  check(
    "B. summing exactly to the total",
    arnonaRows.reduce((s, r) => s + Number(r.scheduledAmount), 0) === 7200,
  );

  const rent = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "שכירות",
      payeeId: payee.id,
      scheduleKind: "RECURRING",
      recurringAmount: "6000.00",
      recurrence: "MONTHLY",
      firstDueAt: due("2026-07-01T09:00:00.000Z"),
    }),
  );
  const rentRows = await asA(() =>
    prisma.installment.findMany({ where: { commitmentId: rent.id } }),
  );
  check("D. RECURRING materialises exactly ONE installment", rentRows.length === 1);
  check("D. and carries no total", rent.totalAmount === null);

  await rejects(
    "a RECURRING commitment with a total is refused",
    () =>
      asA(() =>
        svc.createCommitment({
          businessId: A,
          title: "bad",
          payeeId: payee.id,
          scheduleKind: "RECURRING",
          totalAmount: "100",
          recurringAmount: "100",
          recurrence: "MONTHLY",
          firstDueAt: due("2026-07-01T09:00:00.000Z"),
        }),
      ),
    /must not carry a total/,
  );

  /* ── E/F/G/X. payments and derived balances ─────────────────────────────── */
  console.log("\n[E/F/G/X] payments and derived balances");
  const pay1 = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "1200.00",
      paidAt: due("2027-01-16T09:00:00.000Z"),
      method: "BANK_TRANSFER",
      installmentIds: [arnonaRows[0].id],
    }),
  );
  check("E. a full payment allocates once", pay1.allocations.length === 1);
  check("E. nothing left unallocated", pay1.unallocated === "0.00");

  let bal = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }));
  check("X. paid is derived as 1,200", bal.paid === "1200.00");
  check("X. remaining is derived as 6,000", bal.remaining === "6000.00");
  check("E. the first installment reads PAID", bal.installments[0].state === "PAID");

  const partial = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "400.00",
      paidAt: due("2027-03-16T09:00:00.000Z"),
      method: "CASH",
      installmentIds: [arnonaRows[1].id],
    }),
  );
  bal = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }));
  check("F. a partial payment reads PARTIALLY_PAID", bal.installments[1].state === "PARTIALLY_PAID");
  check("F. with 800 remaining on it", bal.installments[1].remaining === "800.00");

  await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "800.00",
      paidAt: due("2027-03-20T09:00:00.000Z"),
      method: "CASH",
      installmentIds: [arnonaRows[1].id],
    }),
  );
  bal = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }));
  check("G. a second payment completes the installment", bal.installments[1].state === "PAID");
  check("G. and the rollup follows", bal.paid === "2400.00" && bal.remaining === "4800.00");

  /* ── H/I. one payment, several installments + surplus ───────────────────── */
  console.log("\n[H/I] multi-installment and surplus");
  const multi = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: arnona.id,
      amount: "5000.00",
      paidAt: due("2027-05-16T09:00:00.000Z"),
      method: "BANK_TRANSFER",
    }),
  );
  check("H. one payment spreads across the remaining installments", multi.allocations.length === 4);
  check("I. the surplus is reported, not applied", multi.unallocated === "200.00");
  bal = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }));
  check("I. and no installment was overpaid", bal.remaining === "0.00");
  check(
    "I. every installment reads PAID",
    bal.installments.every((i) => i.state === "PAID"),
  );

  /* ── J. overpayment refused ─────────────────────────────────────────────── */
  console.log("\n[J] overpayment refused");
  const solo = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "over",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "100.00",
      firstDueAt: due("2026-08-01T09:00:00.000Z"),
    }),
  );
  const over = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: solo.id,
      amount: "500.00",
      paidAt: due("2026-08-02T09:00:00.000Z"),
      method: "CASH",
    }),
  );
  check("J. only the remaining 100 is allocated", over.allocations.length === 1);
  check("J. the other 400 stays unallocated", over.unallocated === "400.00");
  const soloBal = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: solo.id }),
  );
  check("J. and the balance never goes negative", soloBal.remaining === "0.00");

  /* ── K. concurrent over-allocation ──────────────────────────────────────── */
  console.log("\n[K] concurrency");
  const race = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "race",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "1000.00",
      firstDueAt: due("2026-09-01T09:00:00.000Z"),
    }),
  );
  // Two payments of 1,000 fired at once against a single 1,000 installment. If
  // the row lock did not serialize them, both would observe "1,000 remaining"
  // and both would allocate it — 2,000 against a 1,000 obligation.
  const [r1, r2] = await Promise.all([
    asA(() =>
      svc.recordManualPayment({
        businessId: A,
        commitmentId: race.id,
        amount: "1000.00",
        paidAt: due("2026-09-02T09:00:00.000Z"),
        method: "CASH",
      }),
    ),
    asA(() =>
      svc.recordManualPayment({
        businessId: A,
        commitmentId: race.id,
        amount: "1000.00",
        paidAt: due("2026-09-02T09:00:00.000Z"),
        method: "CASH",
      }),
    ),
  ]);
  const raceBal = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: race.id }),
  );
  const allocatedTotal = r1.allocations.length + r2.allocations.length;
  check("K. exactly ONE of the two concurrent payments allocated", allocatedTotal === 1, `got ${allocatedTotal}`);
  check("K. the installment is paid exactly once", raceBal.paid === "1000.00");
  check("K. and is not overpaid", raceBal.remaining === "0.00");
  check(
    "K. the loser's money is surfaced as unallocated, not lost",
    [r1.unallocated, r2.unallocated].includes("1000.00"),
  );

  /* ── L/M/N. void, reversal, re-allocation ───────────────────────────────── */
  console.log("\n[L/M/N] void, reversal, re-allocation");
  await asA(() => svc.voidPayment({ businessId: A, paymentId: pay1.payment.id, reason: "test" }));
  const afterVoid = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: arnona.id }),
  );
  check("L. voiding removes its allocation from the balance", afterVoid.paid !== "7200.00");
  const stillThere = await asA(() =>
    prisma.paymentAllocation.findMany({ where: { paymentId: pay1.payment.id } }),
  );
  check("L. but the allocation row is NOT deleted", stillThere.length === 1);
  check("L. and was not rewritten", stillThere[0].reversedAt === null);
  check("L. the installment is owed again", afterVoid.installments[0].state !== "PAID");

  const toReverse = partial.allocations[0];
  await asA(() =>
    svc.reverseAllocation({ businessId: A, allocationId: toReverse.id, reason: "wrong installment" }),
  );
  const reversedRow = await asA(() =>
    prisma.paymentAllocation.findFirst({ where: { id: toReverse.id } }),
  );
  check("M. the allocation is stamped reversed", reversedRow?.reversedAt !== null);
  check("M. the row still exists", reversedRow !== null);
  check("M. with its reason recorded", reversedRow?.reversalReason === "wrong installment");

  // N. the partial unique index: the reversed pair must be re-allocatable, and
  // a SECOND ACTIVE row for the same pair must be rejected by the database.
  const reAlloc = await asA(() =>
    prisma.paymentAllocation.create({
      data: {
        businessId: A,
        paymentId: toReverse.paymentId,
        installmentId: toReverse.installmentId,
        allocatedAmount: "1.00",
        currency: "ILS",
      },
    }),
  );
  check("N. a reversed pair CAN be allocated again", reAlloc.id > 0);
  await rejects(
    "N. a second ACTIVE allocation for the same pair is rejected by the DB",
    () =>
      asA(() =>
        prisma.paymentAllocation.create({
          data: {
            businessId: A,
            paymentId: toReverse.paymentId,
            installmentId: toReverse.installmentId,
            allocatedAmount: "1.00",
            currency: "ILS",
          },
        }),
      ),
    /[Uu]nique|duplicate key/,
  );

  /* ── O. cancellation ────────────────────────────────────────────────────── */
  console.log("\n[O] installment cancellation");
  const cancelMe = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "cancel",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "300.00",
      firstDueAt: due("2026-10-01T09:00:00.000Z"),
    }),
  );
  const cancelInst = (await asA(() =>
    prisma.installment.findMany({ where: { commitmentId: cancelMe.id } }),
  ))[0];
  await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: cancelMe.id,
      amount: "100.00",
      paidAt: due("2026-10-02T09:00:00.000Z"),
      method: "CASH",
    }),
  );
  await rejects(
    "O. cancelling an installment with an active allocation is refused",
    () => asA(() => svc.cancelInstallment({ businessId: A, installmentId: cancelInst.id })),
    /reverse them first/,
  );
  check("O. and the installment is still SCHEDULED", (await asA(() =>
    prisma.installment.findFirst({ where: { id: cancelInst.id } }),
  ))?.status === "SCHEDULED");

  /* ── P. cross-tenant negative proofs ────────────────────────────────────── */
  console.log("\n[P] tenant isolation");
  const payeeB = await asB(() =>
    svc.createPayee({ businessId: B, displayName: "B's payee", kind: "OTHER" }),
  );
  const commitmentB = await asB(() =>
    svc.createCommitment({
      businessId: B,
      title: "B commitment",
      payeeId: payeeB.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "900.00",
      firstDueAt: due("2026-11-01T09:00:00.000Z"),
    }),
  );

  await rejects(
    "P. A cannot read B's commitment",
    () => asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: commitmentB.id })),
    /not found/i,
  );
  await rejects(
    "P. A cannot pay against B's commitment",
    () =>
      asA(() =>
        svc.recordManualPayment({
          businessId: A,
          commitmentId: commitmentB.id,
          amount: "10.00",
          paidAt: new Date(),
          method: "CASH",
        }),
      ),
    /not found/i,
  );
  await rejects(
    "P. A cannot attach a commitment to B's payee",
    () =>
      asA(() =>
        svc.createCommitment({
          businessId: A,
          title: "cross",
          payeeId: payeeB.id,
          scheduleKind: "ONE_OFF",
          totalAmount: "10.00",
          firstDueAt: new Date(),
        }),
      ),
    /Payee not found/i,
  );
  await rejects(
    "P. A cannot void B's payment",
    () =>
      asA(async () => {
        const bp = await asB(() =>
          svc.recordManualPayment({
            businessId: B,
            commitmentId: commitmentB.id,
            amount: "50.00",
            paidAt: new Date(),
            method: "CASH",
          }),
        );
        return svc.voidPayment({ businessId: A, paymentId: bp.payment.id });
      }),
    /not found/i,
  );
  const aSeesB = await asA(() => prisma.payee.findMany({ where: { id: payeeB.id } }));
  check("P. A's tenant-scoped read cannot see B's payee", aSeesB.length === 0);
  const aAudit = await asA(() =>
    prisma.payablesAuditEvent.findMany({ where: { businessId: B } }),
  );
  check("P. A cannot read B's audit events", aAudit.length === 0);

  /* ── Q. idempotency ─────────────────────────────────────────────────────── */
  console.log("\n[Q] idempotency");
  const idem = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "idem",
      payeeId: payee.id,
      scheduleKind: "ONE_OFF",
      totalAmount: "250.00",
      firstDueAt: due("2026-12-01T09:00:00.000Z"),
    }),
  );
  const key = `retry-${runId}`;
  const first = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: idem.id,
      amount: "250.00",
      paidAt: due("2026-12-02T09:00:00.000Z"),
      method: "CASH",
      idempotencyKey: key,
    }),
  );
  const retry = await asA(() =>
    svc.recordManualPayment({
      businessId: A,
      commitmentId: idem.id,
      amount: "250.00",
      paidAt: due("2026-12-02T09:00:00.000Z"),
      method: "CASH",
      idempotencyKey: key,
    }),
  );
  check("Q. a retry returns the SAME payment", retry.payment.id === first.payment.id);
  check("Q. and is flagged as a replay", retry.replayed === true);
  const idemPayments = await asA(() =>
    prisma.payment.findMany({ where: { businessId: A, idempotencyKey: key } }),
  );
  check("Q. exactly one economic event exists", idemPayments.length === 1);
  const idemBal = await asA(() =>
    svc.getCommitmentBalance({ businessId: A, commitmentId: idem.id }),
  );
  check("Q. and it was not counted twice", idemBal.paid === "250.00");

  /* ── S/T/U/V/R. legacy backfill ─────────────────────────────────────────── */
  console.log("\n[S/T/U/V/R] legacy BusinessObligation backfill");
  const L = await makeBusiness("legacy");
  const legacyRows = await prisma.businessObligation.createManyAndReturn({
    data: [
      { businessId: L, obligeeName: "ספק פתוח", amount: "500.00", dueAt: due("2026-05-01T09:00:00.000Z"), state: "OPEN", recurrence: "NONE" },
      { businessId: L, obligeeName: "ספק ששולם", amount: "700.00", dueAt: due("2026-04-01T09:00:00.000Z"), state: "MET", metAt: due("2026-04-02T09:00:00.000Z"), settlementAssertedBy: "OWNER", recurrence: "NONE" },
      { businessId: L, obligeeName: "ספק ששוחרר", amount: "300.00", dueAt: due("2026-03-01T09:00:00.000Z"), state: "RELEASED", recurrence: "NONE" },
      { businessId: L, obligeeName: "פריסה", amount: "1000.00", dueAt: due("2026-06-01T09:00:00.000Z"), state: "OPEN", recurrence: "NONE", note: "פריסת תשלומים 1/12" },
      { businessId: L, obligeeName: "צק", amount: "1000.00", dueAt: due("2026-06-01T09:00:00.000Z"), state: "OPEN", recurrence: "NONE", note: "צ'ק מס' 500101" },
    ],
  });
  check("legacy fixtures seeded", legacyRows.length === 5);

  const backfillSql = readFileSync(
    join(process.cwd(), "prisma", "migrations", "20260917090200_payables_phase_1a_obligation_backfill", "migration.sql"),
    "utf8",
  );
  const runBackfill = async () => {
    for (const stmt of backfillSql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s && !s.startsWith("--"))) {
      await prisma.$executeRawUnsafe(stmt);
    }
  };
  await runBackfill();

  const migrated = await prisma.commitment.findMany({
    where: { businessId: L },
    include: { installments: true },
    orderBy: { legacyObligationId: "asc" },
  });
  check("S. every obligation became one commitment", migrated.length === 5);
  check("S. each with exactly one installment", migrated.every((c) => c.installments.length === 1));
  check(
    "S. an OPEN obligation stays ACTIVE / SCHEDULED",
    migrated[0].status === "ACTIVE" && migrated[0].installments[0].status === "SCHEDULED",
  );
  check("S. the obligee name became the Tier-1 snapshot", migrated[0].payeeNameSnapshot === "ספק פתוח");
  check("S. and payeeId is left NULL — no entity is guessed", migrated[0].payeeId === null);

  const met = migrated[1];
  check("T. a MET obligation closes the commitment", met.status === "CLOSED");
  check("T. its installment is SETTLED_LEGACY", met.installments[0].status === "SETTLED_LEGACY");
  check("T. carrying the original provenance", met.installments[0].legacySettlementAssertedBy === "OWNER");
  check("T. and the original metAt", met.installments[0].legacyMetAt !== null);

  const synthesized = await prisma.payment.count({ where: { businessId: L } });
  check("T. LEGACY MET → ZERO SYNTHETIC PAYMENTS", synthesized === 0, `found ${synthesized}`);
  const synthAlloc = await prisma.paymentAllocation.count({ where: { businessId: L } });
  check("T. and zero synthetic allocations", synthAlloc === 0);

  check("U. a RELEASED obligation maps to RELEASED", migrated[2].status === "RELEASED");

  check("V. the installments note is NOT parsed into a parent", migrated[3].note === "פריסת תשלומים 1/12");
  check("V. the row stays an independent commitment", migrated[3].installments.length === 1);
  check("V. the cheque note stays text", migrated[4].note === "צ'ק מס' 500101");

  const legacyUntouched = await prisma.businessObligation.count({ where: { businessId: L } });
  check("expand-only: BusinessObligation rows are untouched", legacyUntouched === 5);

  // R. re-running must be a no-op.
  await runBackfill();
  const afterRerun = await prisma.commitment.count({ where: { businessId: L } });
  const instAfter = await prisma.installment.count({ where: { businessId: L } });
  check("R. re-running the backfill creates nothing", afterRerun === 5, `got ${afterRerun}`);
  check("R. and no duplicate installments", instAfter === 5, `got ${instAfter}`);

  /* ── W. audit ───────────────────────────────────────────────────────────── */
  console.log("\n[W] audit trail");
  const events = await asA(() =>
    prisma.payablesAuditEvent.findMany({ where: { businessId: A, commitmentId: arnona.id } }),
  );
  const types = new Set(events.map((e) => e.eventType));
  check("W. commitment creation is audited", types.has("COMMITMENT_CREATED"));
  check("W. payments are audited", types.has("PAYMENT_RECORDED"));
  check("W. allocations are audited", types.has("ALLOCATION_CREATED"));
  check("W. every event carries a hash", events.every((e) => e.eventHash.length === 64));
  const voidEvents = await asA(() =>
    prisma.payablesAuditEvent.findMany({ where: { businessId: A, eventType: "PAYMENT_VOIDED" } }),
  );
  check("W. voiding is audited", voidEvents.length >= 1);
  const revEvents = await asA(() =>
    prisma.payablesAuditEvent.findMany({ where: { businessId: A, eventType: "ALLOCATION_REVERSED" } }),
  );
  check("W. reversal is audited", revEvents.length >= 1);
  const migEvents = await prisma.payablesAuditEvent.findMany({
    where: { businessId: L, eventType: "COMMITMENT_MIGRATED_FROM_OBLIGATION" },
  });
  check("W. the migration records its own provenance", migEvents.length === 5);
  check(
    "W. and states that no payment was synthesized",
    migEvents.every((e) => (e.metadata as { synthesizedPayment?: boolean })?.synthesizedPayment === false),
  );

  /* ── cleanup ────────────────────────────────────────────────────────────── */
  for (const id of [A, B, L]) {
    await prisma.business.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nDB suite crashed:", err);
    process.exit(1);
  });
