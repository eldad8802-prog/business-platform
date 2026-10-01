/**
 * Payment idempotency — DB-backed proofs (PG17).
 *
 * The key's promise, proven against a real Postgres:
 *   same business + same key + same request      → the original Payment (replay)
 *   same business + same key + different request → deterministic conflict, nothing written
 *   two concurrent first requests, same key      → one Payment, both callers answered, no 500
 *   recurrence                                   → exactly one next occurrence, also when a
 *                                                  payment and a secretary "handled" race
 *
 * Run (CI provides an ephemeral postgres:17 service):
 *   TEST_DATABASE_URL="postgres://…" node_modules/.bin/tsx lib/services/payables/payment-idempotency.db.test.ts
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
if (!process.env.AUTH_TOKEN_SECRET?.trim()) process.env.AUTH_TOKEN_SECRET = "payment-idempotency-test-secret";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
async function conflicts(name: string, fn: () => Promise<unknown>, field: RegExp): Promise<void> {
  total += 1;
  try {
    await fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a conflict, none thrown`);
  } catch (err) {
    const ok = (err as Error)?.name === "PayablesConflictError" && field.test((err as Error).message);
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — wrong error: ${(err as Error)?.name}: ${(err as Error)?.message}`}`);
  }
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const svc = await import("@/lib/services/payables/payables.service");
  const { handlePayablesError } = await import("@/lib/services/payables/payables-http");
  const secretary = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps } = await import("@/lib/services/obligations/obligations.deps");

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAllocation_active_payment_installment_key"
      ON "PaymentAllocation"("paymentId", "installmentId")
      WHERE "reversedAt" IS NULL
  `);

  const makeBusiness = async (label: string) =>
    (
      await prisma.business.create({
        data: {
          name: `PayIdem ${label} ${runId}`,
          users: { create: { email: `payidem-${label}-${runId}@example.test`, password: "x", name: "PayIdem" } },
        },
      })
    ).id;
  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B }, fn);
  const D = (iso: string) => new Date(iso);

  const counts = async (businessId: number) => ({
    payments: await prisma.payment.count({ where: { businessId } }),
    allocations: await prisma.paymentAllocation.count({ where: { businessId, reversedAt: null } }),
    installments: await prisma.installment.count({ where: { businessId } }),
    commitments: await prisma.commitment.count({ where: { businessId } }),
    evidence: await prisma.paymentEvidence.count({ where: { businessId } }),
  });
  const monthly = (title: string, amount: string, firstDueAt: string) =>
    asA(() =>
      svc.createCommitment({
        businessId: A,
        title,
        payeeNameSnapshot: title,
        scheduleKind: "RECURRING",
        recurrence: "MONTHLY",
        recurringAmount: amount,
        firstDueAt: D(firstDueAt),
      } as Parameters<typeof svc.createCommitment>[0]),
    );
  const firstInstallment = async (commitmentId: number) =>
    (await prisma.installment.findFirstOrThrow({ where: { commitmentId, sequence: 1 } })).id;

  /* ── 1 · first request, exact replay ───────────────────────────────────── */
  console.log("\n[1] first request and exact replay");
  const ins = await monthly("ביטוח", "50.00", "2026-09-29T06:00:00.000Z");
  const i1 = await firstInstallment(ins.id);
  const key = `secretary:${i1}:2026-09-29:50.00`;
  const req = {
    businessId: A,
    commitmentId: ins.id,
    installmentIds: [i1],
    amount: "50.00",
    paidAt: D("2026-09-29T09:00:00.000Z"),
    method: "BANK_TRANSFER",
    idempotencyKey: key,
  };
  const first = await asA(() => svc.recordManualPayment(req));
  check("first request records a payment (not a replay)", first.replayed === false);
  check("one allocation of 50.00 to the occurrence", first.allocations.length === 1 && first.allocations[0].installmentId === i1);
  const afterFirst = await counts(A);
  check("recurrence: exactly one next occurrence materialised", (await prisma.installment.count({ where: { commitmentId: ins.id } })) === 2);
  const recorded = await prisma.payablesAuditEvent.findFirstOrThrow({ where: { paymentId: first.payment.id, eventType: "PAYMENT_RECORDED" } });
  const meta = recorded.metadata as { request?: { paidDate: string; amountMinor: number }; requestFingerprint?: string };
  check("the request identity is stored on PAYMENT_RECORDED", meta.request?.paidDate === "2026-09-29" && meta.request?.amountMinor === 5000 && /^[0-9a-f]{64}$/.test(meta.requestFingerprint ?? ""));

  const replay = await asA(() => svc.recordManualPayment({ ...req }));
  check("exact replay returns the SAME payment", replay.payment.id === first.payment.id);
  check("and is flagged replayed", replay.replayed === true);
  check("and returns the active allocation set", replay.allocations.length === 1 && replay.allocations[0].id === first.allocations[0].id);
  const padded = await asA(() => svc.recordManualPayment({ ...req, idempotencyKey: `  ${key}  ` }));
  check("a key differing only in surrounding whitespace is the same key", padded.payment.id === first.payment.id && padded.replayed);
  const sameDayOtherTime = await asA(() => svc.recordManualPayment({ ...req, paidAt: D("2026-09-29T15:30:00.000Z") }));
  check("same Israel paid date at another clock time is the same request (replay)", sameDayOtherTime.payment.id === first.payment.id);
  const annotated = await asA(() => svc.recordManualPayment({ ...req, note: "retry from another tab" }));
  check("a different note is not part of the identity (replay)", annotated.payment.id === first.payment.id);
  const afterReplays = await counts(A);
  check("replays wrote nothing: payments / allocations / installments / evidence unchanged", JSON.stringify(afterReplays) === JSON.stringify(afterFirst), JSON.stringify(afterReplays));

  /* ── 2 · same key, different request → conflict, nothing written ───────── */
  console.log("\n[2] same key, materially different request → conflict");
  const other = await monthly("שכירות", "100.00", "2026-09-29T06:00:00.000Z");
  const otherI1 = await firstInstallment(other.id);
  const i2 = (await prisma.installment.findFirstOrThrow({ where: { commitmentId: ins.id, sequence: 2 } })).id;
  await conflicts("changed amount", () => asA(() => svc.recordManualPayment({ ...req, amount: "40.00" })), /amountMinor/);
  await conflicts("changed installment", () => asA(() => svc.recordManualPayment({ ...req, installmentIds: [i2] })), /installmentIds/);
  await conflicts("installment list → due-date order", () => asA(() => svc.recordManualPayment({ ...req, installmentIds: null })), /installmentIds/);
  await conflicts(
    "changed commitment",
    () => asA(() => svc.recordManualPayment({ ...req, commitmentId: other.id, installmentIds: [otherI1] })),
    /commitmentId/,
  );
  await conflicts("changed paid date (another Israel day)", () => asA(() => svc.recordManualPayment({ ...req, paidAt: D("2026-09-30T09:00:00.000Z") })), /paidDate/);
  await conflicts("changed method", () => asA(() => svc.recordManualPayment({ ...req, method: "CASH" })), /method/);
  await conflicts("changed external reference", () => asA(() => svc.recordManualPayment({ ...req, externalReference: "BANK-REF-9" })), /externalReference/);
  const afterConflicts = await counts(A);
  check("conflicts created nothing (only the second commitment's own rows exist)", afterConflicts.payments === afterFirst.payments && afterConflicts.allocations === afterFirst.allocations && afterConflicts.evidence === afterFirst.evidence);
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: first.payment.id } });
  check("the original payment was not mutated", p.amount.toString() === "50" && p.method === "BANK_TRANSFER" && p.paidAt.toISOString() === "2026-09-29T09:00:00.000Z" && p.updatedAt.getTime() === first.payment.updatedAt.getTime());
  const httpConflict = await asA(() => svc.recordManualPayment({ ...req, amount: "40.00" }).then(() => null, (e) => handlePayablesError(e)));
  check("the route answers a conflict with 409, not 500", httpConflict?.status === 409, String(httpConflict?.status));
  const crossTenant = await asB(() => svc.recordManualPayment({ ...req, businessId: B }).then(() => "accepted", (e: Error) => e.name));
  check("the same key in ANOTHER business is not A's payment (B cannot reach A's commitment)", crossTenant === "PayablesNotFoundError", crossTenant);

  /* ── 3 · concurrent identical first requests ───────────────────────────── */
  console.log("\n[3] concurrent identical first requests");
  const c3 = await monthly("חשמל", "300.00", "2026-10-01T06:00:00.000Z");
  const c3i = await firstInstallment(c3.id);
  const req3 = { ...req, commitmentId: c3.id, installmentIds: [c3i], amount: "300.00", paidAt: D("2026-10-01T09:00:00.000Z"), idempotencyKey: `race-same-${runId}` };
  const before3 = await counts(A);
  const r3 = await Promise.allSettled([asA(() => svc.recordManualPayment(req3)), asA(() => svc.recordManualPayment(req3))]);
  check("both callers answered (no rejection, no 500)", r3.every((r) => r.status === "fulfilled"), JSON.stringify(r3.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
  const ok3 = r3.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.recordManualPayment>>> => r.status === "fulfilled").map((r) => r.value);
  check("they name the same payment", ok3.length === 2 && ok3[0].payment.id === ok3[1].payment.id);
  check("exactly one is new and one is a replay", ok3.filter((r) => r.replayed).length === 1);
  const after3 = await counts(A);
  check("exactly one Payment, one allocation, one evidence", after3.payments - before3.payments === 1 && after3.allocations - before3.allocations === 1 && after3.evidence - before3.evidence === 1);
  check("exactly one next occurrence", (await prisma.installment.count({ where: { commitmentId: c3.id } })) === 2);

  /* ── 4 · concurrent conflicting first requests ─────────────────────────── */
  console.log("\n[4] concurrent conflicting first requests");
  const c4 = await monthly("מים", "120.00", "2026-10-02T06:00:00.000Z");
  const c4i = await firstInstallment(c4.id);
  const req4 = { ...req, commitmentId: c4.id, installmentIds: [c4i], amount: "120.00", paidAt: D("2026-10-02T09:00:00.000Z"), idempotencyKey: `race-diff-${runId}` };
  const before4 = await counts(A);
  const r4 = await Promise.allSettled([asA(() => svc.recordManualPayment(req4)), asA(() => svc.recordManualPayment({ ...req4, amount: "60.00" }))]);
  const rejected4 = r4.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  check("one succeeds, the other is a deterministic conflict", r4.filter((r) => r.status === "fulfilled").length === 1 && rejected4.length === 1 && rejected4[0].reason?.name === "PayablesConflictError", JSON.stringify(r4.map((r) => (r.status === "rejected" ? `${r.reason?.name}: ${r.reason?.message}` : "ok"))));
  const after4 = await counts(A);
  check("exactly one Payment and its allocation set", after4.payments - before4.payments === 1 && after4.allocations - before4.allocations === 1);

  // Different commitments share no row lock: the loser blocks on the unique index itself.
  const c4b = await monthly("גז", "80.00", "2026-10-03T06:00:00.000Z");
  const c4c = await monthly("ארנונה", "80.00", "2026-10-03T06:00:00.000Z");
  const k4b = `race-commit-${runId}`;
  const mk = (commitmentId: number, inst: number) => ({ ...req, commitmentId, installmentIds: [inst], amount: "80.00", paidAt: D("2026-10-03T09:00:00.000Z"), idempotencyKey: k4b });
  const r4b = await Promise.allSettled([
    asA(async () => svc.recordManualPayment(mk(c4b.id, await firstInstallment(c4b.id)))),
    asA(async () => svc.recordManualPayment(mk(c4c.id, await firstInstallment(c4c.id)))),
  ]);
  const rej4b = r4b.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  check("same key on two commitments at once → one payment + one conflict on commitmentId", rej4b.length === 1 && rej4b[0].reason?.name === "PayablesConflictError" && /commitmentId/.test(rej4b[0].reason?.message), JSON.stringify(r4b.map((r) => (r.status === "rejected" ? `${r.reason?.name}: ${r.reason?.message}` : "ok"))));
  check("and exactly one payment under that key", (await prisma.payment.count({ where: { businessId: A, idempotencyKey: k4b } })) === 1);
  check("and no 'loser' allocation on the second commitment", (await prisma.paymentAllocation.count({ where: { businessId: A, installment: { commitmentId: { in: [c4b.id, c4c.id] } } } })) === 1);

  /* ── 5 · payments recorded before fingerprints (legacy comparison) ─────── */
  console.log("\n[5] payment recorded before request fingerprints existed");
  const c5 = await monthly("טלפון", "90.00", "2026-10-04T06:00:00.000Z");
  const c5i = await firstInstallment(c5.id);
  const req5 = { ...req, commitmentId: c5.id, installmentIds: [c5i], amount: "90.00", paidAt: D("2026-10-04T09:00:00.000Z"), idempotencyKey: `legacy-${runId}` };
  const p5 = await asA(() => svc.recordManualPayment(req5));
  // Strip what this change adds, so the row looks exactly like a pre-change one.
  const ev5 = await prisma.payablesAuditEvent.findFirstOrThrow({ where: { paymentId: p5.payment.id, eventType: "PAYMENT_RECORDED" } });
  await prisma.payablesAuditEvent.update({ where: { id: ev5.id }, data: { metadata: { amount: "90.00", unallocated: "0.00", method: "BANK_TRANSFER" } } });
  const legacyReplay = await asA(() => svc.recordManualPayment(req5));
  check("legacy: the same request replays", legacyReplay.replayed && legacyReplay.payment.id === p5.payment.id);
  await conflicts("legacy: a changed amount conflicts", () => asA(() => svc.recordManualPayment({ ...req5, amount: "91.00" })), /amountMinor/);
  await conflicts("legacy: another installment conflicts", () => asA(() => svc.recordManualPayment({ ...req5, installmentIds: [c5i + 100000] })), /installmentIds/);

  /* ── 6 · recurrence exactly once when a payment and "handled" race ────── */
  console.log("\n[6] payment and secretary 'handled' on the same occurrence, concurrently");
  process.env.SECRETARY_LEDGER_STORE = "true";
  for (let round = 0; round < 5; round++) {
    const c6 = await monthly(`ניקיון ${round}`, "200.00", "2026-10-05T06:00:00.000Z");
    const c6i = await firstInstallment(c6.id);
    const r6 = await Promise.allSettled([
      asA(() => svc.recordManualPayment({ ...req, commitmentId: c6.id, installmentIds: [c6i], amount: "200.00", paidAt: D("2026-10-05T09:00:00.000Z"), idempotencyKey: `race-handled-${round}-${runId}` })),
      tenantTx(A, (tx) => secretary.completeObligation(A, c6i, obligationServiceDeps({ tx, actorUserId: undefined }))),
    ]);
    const n6 = await prisma.installment.count({ where: { commitmentId: c6.id } });
    const seq = await prisma.installment.groupBy({ by: ["sequence"], where: { commitmentId: c6.id }, _count: true });
    check(
      `round ${round}: both succeed; exactly one next occurrence (2 installments, unique sequences)`,
      r6.every((r) => r.status === "fulfilled") && n6 === 2 && seq.every((s) => s._count === 1),
      JSON.stringify({ n6, r: r6.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")) }),
    );
  }

  /* ── cleanup ────────────────────────────────────────────────────────────── */
  for (const id of [A, B]) await prisma.business.delete({ where: { id } }).catch(() => {});
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
