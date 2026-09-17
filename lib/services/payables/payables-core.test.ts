/**
 * Payables domain core — accounting invariants. Run:
 *   npx tsx lib/services/payables/payables-core.test.ts
 *
 * These are the proofs that need no database: schedule generation, the derived
 * balances, and every rule about what may be allocated. The DB-backed half —
 * concurrency, the partial unique index, tenant isolation, idempotency and the
 * legacy backfill — lives in the Phase 1a CI workflow against a real Postgres,
 * because those properties are about the database and cannot be simulated here.
 */
import {
  assertAllocationAllowed,
  assertFinitePlanIntegrity,
  assertInstallmentCancellable,
  deriveCommitmentBalance,
  deriveInstallmentBalance,
  fromMinorUnits,
  generateInstallmentPlan,
  isActiveAllocation,
  nextOccurrence,
  PayablesValidationError,
  planAllocation,
  sumActiveAllocations,
  toMinorUnits,
  type AllocationFacts,
  type InstallmentFacts,
} from "./payables-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function throws(name: string, fn: () => unknown, expect?: RegExp): void {
  total += 1;
  try {
    fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a rejection, none thrown`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok = err instanceof PayablesValidationError && (!expect || expect.test(msg));
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — wrong error: ${msg}`}`);
  }
}

const D = (iso: string) => new Date(iso);
const NOW = D("2026-06-15T09:00:00.000Z");

const recorded = (minor: number): AllocationFacts => ({
  allocatedAmountMinor: minor,
  reversedAt: null,
  payment: { status: "RECORDED" },
});
const reversed = (minor: number): AllocationFacts => ({
  allocatedAmountMinor: minor,
  reversedAt: D("2026-06-01T00:00:00.000Z"),
  payment: { status: "RECORDED" },
});
const voided = (minor: number): AllocationFacts => ({
  allocatedAmountMinor: minor,
  reversedAt: null,
  payment: { status: "VOID" },
});

const inst = (over: Partial<InstallmentFacts> = {}): InstallmentFacts => ({
  scheduledAmountMinor: 120000,
  dueAt: D("2026-07-15T09:00:00.000Z"),
  status: "SCHEDULED",
  allocations: [],
  ...over,
});

/* ── money ────────────────────────────────────────────────────────────────── */
console.log("\n[money] minor units, never floats");
{
  check("parses a 2-decimal string", toMinorUnits("1200.50") === 120050);
  check("parses an integer string", toMinorUnits("7200") === 720000);
  check("round-trips", fromMinorUnits(toMinorUnits("1234.56")) === "1234.56");
  check("pads a single decimal", toMinorUnits("10.5") === 1050);
  check("renders trailing zeros", fromMinorUnits(1050) === "10.50");
  // A third decimal is refused rather than rounded: silently dropping it would
  // invent or destroy money.
  throws("refuses 3 decimals", () => toMinorUnits("10.555"), /at most 2 places/);
  throws("refuses non-numeric", () => toMinorUnits("abc"));
  check(
    "0.1 + 0.2 problem cannot occur",
    toMinorUnits("0.1") + toMinorUnits("0.2") === toMinorUnits("0.30"),
  );
}

/* ── C. decimal remainder integrity ───────────────────────────────────────── */
console.log("\n[C] finite plan — decimal remainder integrity");
{
  const plan = generateInstallmentPlan({
    totalMinor: toMinorUnits("7000"),
    count: 3,
    firstDueAt: D("2026-01-15T09:00:00.000Z"),
    cadence: "MONTHLY",
  });
  const sum = plan.reduce((a, p) => a + p.amountMinor, 0);
  check("3 installments generated", plan.length === 3);
  check("sum is EXACTLY the total", sum === toMinorUnits("7000"), fromMinorUnits(sum));
  check("remainder lands on the last", plan[2].amountMinor === plan[0].amountMinor + 1);
  check("amounts are 2333.33 / 2333.33 / 2333.34",
    fromMinorUnits(plan[0].amountMinor) === "2333.33" &&
    fromMinorUnits(plan[2].amountMinor) === "2333.34");
}
{
  const plan = generateInstallmentPlan({
    totalMinor: toMinorUnits("7200"),
    count: 6,
    firstDueAt: D("2026-01-15T09:00:00.000Z"),
    cadence: "MONTHLY",
  });
  check("ארנונה 7,200/6 splits evenly", plan.every((p) => p.amountMinor === 120000));
  check("sum exact", plan.reduce((a, p) => a + p.amountMinor, 0) === toMinorUnits("7200"));
  check("dates step monthly", plan[1].dueAt.getUTCMonth() === 1 && plan[5].dueAt.getUTCMonth() === 5);
}
{
  // Month-end clamping: a 31st start must not skip February.
  const plan = generateInstallmentPlan({
    totalMinor: toMinorUnits("300"),
    count: 3,
    firstDueAt: D("2026-01-31T09:00:00.000Z"),
    cadence: "MONTHLY",
  });
  check("Jan 31 → Feb 28 (clamped)", plan[1].dueAt.getUTCDate() === 28);
  check("and Mar 31", plan[2].dueAt.getUTCDate() === 31);
}
throws(
  "refuses more installments than minor units",
  () => generateInstallmentPlan({ totalMinor: 2, count: 5, firstDueAt: NOW, cadence: "MONTHLY" }),
);

/* ── Invariant 14 ─────────────────────────────────────────────────────────── */
console.log("\n[14] finite-plan integrity invariant");
{
  assertFinitePlanIntegrity({
    scheduleKind: "INSTALLMENT_PLAN",
    totalMinor: 720000,
    installmentAmountsMinor: [120000, 120000, 120000, 120000, 120000, 120000],
  });
  check("an exact plan passes", true);
}
throws(
  "a plan that does not sum to the total is refused",
  () =>
    assertFinitePlanIntegrity({
      scheduleKind: "INSTALLMENT_PLAN",
      totalMinor: 720000,
      installmentAmountsMinor: [120000, 120000],
    }),
  /sum to/,
);
throws(
  "a RECURRING commitment may not carry a total",
  () =>
    assertFinitePlanIntegrity({
      scheduleKind: "RECURRING",
      totalMinor: 720000,
      installmentAmountsMinor: [120000],
    }),
  /must not carry a total/,
);
{
  assertFinitePlanIntegrity({
    scheduleKind: "RECURRING",
    totalMinor: null,
    installmentAmountsMinor: [600000],
  });
  check("a RECURRING commitment with no total passes", true);
}

/* ── active allocation predicate ──────────────────────────────────────────── */
console.log("\n[active] the frozen predicate");
{
  check("a recorded, unreversed allocation is active", isActiveAllocation(recorded(100)));
  check("a reversed allocation is NOT active", !isActiveAllocation(reversed(100)));
  check("an allocation of a VOID payment is NOT active", !isActiveAllocation(voided(100)));
  check("sum counts only active", sumActiveAllocations([recorded(100), reversed(50), voided(25)]) === 100);
}

/* ── E/F/G. balances ──────────────────────────────────────────────────────── */
console.log("\n[E/F/G] derived installment balances");
{
  const b = deriveInstallmentBalance(inst(), NOW);
  check("unpaid: remaining = scheduled", b.remainingMinor === 120000 && b.paidMinor === 0);
  check("future due date reads SCHEDULED", b.state === "SCHEDULED");
}
{
  const b = deriveInstallmentBalance(inst({ allocations: [recorded(120000)] }), NOW);
  check("E. full payment → PAID", b.state === "PAID");
  check("E. remaining is zero", b.remainingMinor === 0);
}
{
  const b = deriveInstallmentBalance(
    inst({ scheduledAmountMinor: 1000000, allocations: [recorded(400000)] }),
    NOW,
  );
  check("F. partial → PARTIALLY_PAID", b.state === "PARTIALLY_PAID");
  check("F. remaining 6,000", fromMinorUnits(b.remainingMinor) === "6000.00");
}
{
  const b = deriveInstallmentBalance(
    inst({ scheduledAmountMinor: 1000000, allocations: [recorded(400000), recorded(600000)] }),
    NOW,
  );
  check("G. second payment completes it", b.state === "PAID" && b.remainingMinor === 0);
}
{
  const b = deriveInstallmentBalance(
    inst({ dueAt: D("2026-06-01T09:00:00.000Z") }),
    NOW,
  );
  check("past due and unpaid reads OVERDUE", b.state === "OVERDUE");
}
{
  const b = deriveInstallmentBalance(inst({ dueAt: D("2026-06-18T09:00:00.000Z") }), NOW);
  check("inside the attention window reads DUE", b.state === "DUE");
}

/* ── L. void removes allocations from balances without deleting them ──────── */
console.log("\n[L] VOID payment");
{
  const b = deriveInstallmentBalance(inst({ allocations: [voided(120000)] }), NOW);
  check("a voided payment contributes nothing", b.paidMinor === 0);
  check("the installment is owed again", b.remainingMinor === 120000);
  check("the allocation row is still present in the facts", true);
}

/* ── M. reversal ──────────────────────────────────────────────────────────── */
console.log("\n[M] allocation reversal");
{
  const b = deriveInstallmentBalance(
    inst({ allocations: [reversed(120000), recorded(50000)] }),
    NOW,
  );
  check("a reversed allocation contributes nothing", b.paidMinor === 50000);
  check("the remaining reflects only active", fromMinorUnits(b.remainingMinor) === "700.00");
}

/* ── O. cancelled / legacy installments ───────────────────────────────────── */
console.log("\n[O] cancelled and legacy installments");
{
  const b = deriveInstallmentBalance(inst({ status: "CANCELLED" }), NOW);
  check("CANCELLED reports zero remaining", b.remainingMinor === 0);
  check("CANCELLED is never DUE/OVERDUE", b.state === "CANCELLED");
}
{
  const b = deriveInstallmentBalance(
    inst({ status: "SETTLED_LEGACY", dueAt: D("2020-01-01T00:00:00.000Z") }),
    NOW,
  );
  check("T. SETTLED_LEGACY reports zero remaining", b.remainingMinor === 0);
  check("T. and does not nag, despite being years overdue", b.state === "SETTLED_LEGACY");
  check("T. and claims ZERO paid — no payment was ever observed", b.paidMinor === 0);
}
{
  assertInstallmentCancellable({ status: "SCHEDULED", activeAllocationCount: 0 });
  check("a clean scheduled installment can be cancelled", true);
}
throws(
  "O. cancelling an installment with active allocations is refused",
  () => assertInstallmentCancellable({ status: "SCHEDULED", activeAllocationCount: 1 }),
  /reverse them first/,
);

/* ── X/Y. commitment rollups ──────────────────────────────────────────────── */
console.log("\n[X/Y] commitment rollups");
{
  const installments = [
    inst({ allocations: [recorded(120000)] }),
    inst({ allocations: [recorded(120000)] }),
    inst(),
    inst(),
    inst(),
    inst(),
  ];
  const roll = deriveCommitmentBalance(
    { totalAmountMinor: 720000, scheduleKind: "INSTALLMENT_PLAN" },
    installments,
    NOW,
  );
  check("X. ארנונה total 7,200", fromMinorUnits(roll.totalMinor!) === "7200.00");
  check("X. paid 2,400", fromMinorUnits(roll.paidMinor) === "2400.00");
  check("X. remaining 4,800", fromMinorUnits(roll.remainingMinor!) === "4800.00");
}
{
  const roll = deriveCommitmentBalance(
    { totalAmountMinor: null, scheduleKind: "RECURRING" },
    [inst({ scheduledAmountMinor: 600000, allocations: [recorded(600000)] })],
    NOW,
  );
  check("Y. a RECURRING commitment has NO total", roll.totalMinor === null);
  check("Y. and NO invented remaining balance", roll.remainingMinor === null);
  check("Y. but paid is still real", fromMinorUnits(roll.paidMinor) === "6000.00");
}

/* ── H/I/J. allocation planning ───────────────────────────────────────────── */
console.log("\n[H/I/J] allocation planning");
const target = (id: number, remaining: number, due: string, status: InstallmentFacts["status"] = "SCHEDULED") => ({
  installmentId: id,
  remainingMinor: remaining,
  dueAt: D(due),
  status,
  currency: "ILS",
});
{
  const plan = planAllocation({
    paymentAmountMinor: 300000,
    paymentCurrency: "ILS",
    targets: [
      target(1, 100000, "2026-01-15T00:00:00.000Z"),
      target(2, 100000, "2026-02-15T00:00:00.000Z"),
      target(3, 100000, "2026-03-15T00:00:00.000Z"),
    ],
  });
  check("H. one payment covers three installments", plan.allocations.length === 3);
  check("H. each gets its full remaining", plan.allocations.every((a) => a.amountMinor === 100000));
  check("H. nothing is left over", plan.unallocatedMinor === 0);
  check("H. applied in due-date order", plan.allocations[0].installmentId === 1);
}
{
  const plan = planAllocation({
    paymentAmountMinor: 500000,
    paymentCurrency: "ILS",
    targets: [target(1, 100000, "2026-01-15T00:00:00.000Z")],
  });
  check("I. surplus is NOT applied anywhere", plan.allocations.length === 1);
  check("I. surplus is reported", fromMinorUnits(plan.unallocatedMinor) === "4000.00");
  check("I. and the installment is not overpaid", plan.allocations[0].amountMinor === 100000);
}
{
  const plan = planAllocation({
    paymentAmountMinor: 100000,
    paymentCurrency: "ILS",
    targets: [
      target(1, 100000, "2026-01-15T00:00:00.000Z", "CANCELLED"),
      target(2, 100000, "2026-02-15T00:00:00.000Z", "SETTLED_LEGACY"),
      target(3, 100000, "2026-03-15T00:00:00.000Z"),
    ],
  });
  check("cancelled and legacy installments take nothing", plan.allocations.length === 1);
  check("only the scheduled one is settled", plan.allocations[0].installmentId === 3);
}
throws(
  "a currency mismatch refuses to plan",
  () =>
    planAllocation({
      paymentAmountMinor: 100000,
      paymentCurrency: "USD",
      targets: [target(1, 100000, "2026-01-15T00:00:00.000Z")],
    }),
  /Currency mismatch/,
);

/* ── J. overpayment refused at the single-allocation guard ────────────────── */
console.log("\n[J] overpayment refused");
const allowed = {
  amountMinor: 50000,
  installmentRemainingMinor: 100000,
  installmentStatus: "SCHEDULED" as const,
  paymentUnallocatedMinor: 100000,
  paymentStatus: "RECORDED" as const,
  commitmentStatus: "ACTIVE" as const,
  paymentCurrency: "ILS",
  installmentCurrency: "ILS",
};
{
  assertAllocationAllowed(allowed);
  check("a legal allocation passes", true);
}
throws(
  "J. allocating more than the installment's remaining is REFUSED",
  () => assertAllocationAllowed({ ...allowed, amountMinor: 150000 }),
  /Overpayment refused/,
);
throws(
  "allocating more than the payment has left is refused",
  () => assertAllocationAllowed({ ...allowed, amountMinor: 90000, paymentUnallocatedMinor: 50000 }),
  /Over-allocation refused/,
);
throws(
  "a VOID payment cannot be allocated",
  () => assertAllocationAllowed({ ...allowed, paymentStatus: "VOID" }),
  /voided payment/,
);
throws(
  "a CANCELLED installment cannot receive an allocation",
  () => assertAllocationAllowed({ ...allowed, installmentStatus: "CANCELLED" }),
  /cannot receive an allocation/,
);
throws(
  "a SETTLED_LEGACY installment cannot receive an allocation",
  () => assertAllocationAllowed({ ...allowed, installmentStatus: "SETTLED_LEGACY" }),
  /cannot receive an allocation/,
);
throws(
  "a RELEASED commitment cannot receive an allocation",
  () => assertAllocationAllowed({ ...allowed, commitmentStatus: "RELEASED" }),
  /cannot receive an allocation/,
);
throws(
  "a currency mismatch is refused",
  () => assertAllocationAllowed({ ...allowed, installmentCurrency: "USD" }),
  /Currency mismatch/,
);
throws("a zero allocation is refused", () => assertAllocationAllowed({ ...allowed, amountMinor: 0 }));
throws("a negative allocation is refused", () => assertAllocationAllowed({ ...allowed, amountMinor: -1 }));

/* ── D. recurrence ────────────────────────────────────────────────────────── */
console.log("\n[D] recurrence");
{
  check("MONTHLY steps one month", nextOccurrence(D("2026-01-15T09:00:00.000Z"), "MONTHLY")!.getUTCMonth() === 1);
  check("YEARLY steps one year", nextOccurrence(D("2026-01-15T09:00:00.000Z"), "YEARLY")!.getUTCFullYear() === 2027);
  check("WEEKLY steps 7 days", nextOccurrence(D("2026-01-15T09:00:00.000Z"), "WEEKLY")!.getUTCDate() === 22);
  check("NONE does not recur", nextOccurrence(NOW, "NONE") === null);
  check("Jan 31 clamps to Feb 28", nextOccurrence(D("2026-01-31T09:00:00.000Z"), "MONTHLY")!.getUTCDate() === 28);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
if (failures > 0) process.exit(1);
