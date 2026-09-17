/**
 * Payables domain core — pure, DB-free.
 *
 * Every accounting decision that can be made without touching a database is
 * made here: how a schedule is generated, what a balance IS, which allocations
 * count, and whether a proposed allocation is legal. The service layer loads
 * rows and feeds plain values in, exactly as the billing collection rules do,
 * so the regulation-critical arithmetic is unit-testable and has no Prisma in
 * its import graph.
 *
 * ── The one rule everything else follows ─────────────────────────────────────
 *
 * `PaymentAllocation.allocatedAmount` is the ONLY persisted allocation figure.
 * Paid, remaining, PAID, PARTIALLY_PAID, DUE and OVERDUE are all DERIVED here.
 * No cached balance column exists, in this phase or any later one — a stored
 * total drifts the moment an allocation is reversed, and nothing then agrees.
 *
 * Money is handled in minor units (agorot) as integers throughout this module.
 * Decimal strings from the database are converted once at the edge. Floating
 * point never touches an amount.
 */

/** Persisted installment assertions. Everything else about state is derived. */
export type InstallmentStatusValue = "SCHEDULED" | "CANCELLED" | "SETTLED_LEGACY";

/** Persisted payment assertions. */
export type PaymentStatusValue = "RECORDED" | "VOID";

export type CommitmentScheduleKindValue = "ONE_OFF" | "RECURRING" | "INSTALLMENT_PLAN";

export type RecurrenceCadenceValue = "NONE" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** What the owner sees. None of these are stored. */
export type DerivedInstallmentState =
  | "SCHEDULED"
  | "DUE"
  | "OVERDUE"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED"
  | "SETTLED_LEGACY";

export class PayablesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayablesValidationError";
  }
}

/* ─────────────────────────── money (minor units) ─────────────────────────── */

/**
 * Parse a decimal amount into integer minor units.
 *
 * Accepts the string form Prisma returns for `Decimal`, a number, or bigint.
 * Rejects anything that is not a finite amount with at most two decimal places:
 * silently rounding a third decimal would invent or destroy money.
 */
export function toMinorUnits(value: string | number | bigint): number {
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new PayablesValidationError(
      `Amount must be a decimal with at most 2 places, got "${raw}"`,
    );
  }
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = (negative ? raw.slice(1) : raw).split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new PayablesValidationError(`Amount out of safe range: "${raw}"`);
  }
  return negative ? -minor : minor;
}

/** Render integer minor units back to the 2-decimal string the DB stores. */
export function fromMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new PayablesValidationError(`Not a safe integer amount: ${minor}`);
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function assertPositiveAmount(minor: number, label = "amount"): void {
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new PayablesValidationError(`${label} must be a positive amount`);
  }
}

/* ────────────────────────── active allocations ───────────────────────────── */

/**
 * The frozen predicate. An allocation counts toward a balance only while BOTH
 * hold — it has not been reversed, AND its payment has not been voided.
 *
 * Voiding a payment deliberately does not rewrite its allocation rows: one
 * atomic status flip invalidates all of them through this predicate, whereas
 * updating N rows could half-succeed. Nothing is ever deleted; a reversed
 * allocation and a voided payment both stay fully queryable history.
 */
export function isActiveAllocation(allocation: {
  reversedAt: Date | null;
  payment: { status: PaymentStatusValue };
}): boolean {
  return allocation.reversedAt === null && allocation.payment.status === "RECORDED";
}

export type AllocationFacts = {
  allocatedAmountMinor: number;
  reversedAt: Date | null;
  payment: { status: PaymentStatusValue };
};

/** Σ of the active allocations only. */
export function sumActiveAllocations(allocations: AllocationFacts[]): number {
  return allocations.reduce(
    (total, a) => (isActiveAllocation(a) ? total + a.allocatedAmountMinor : total),
    0,
  );
}

/* ───────────────────────────── derived balances ──────────────────────────── */

export type InstallmentFacts = {
  scheduledAmountMinor: number;
  dueAt: Date;
  status: InstallmentStatusValue;
  allocations: AllocationFacts[];
};

export type InstallmentBalance = {
  scheduledMinor: number;
  paidMinor: number;
  remainingMinor: number;
  state: DerivedInstallmentState;
};

/**
 * Everything an installment's state is, computed from what is stored.
 *
 * A CANCELLED or SETTLED_LEGACY installment reports zero remaining and is never
 * DUE or OVERDUE: the first was withdrawn, the second was closed by a pre-ledger
 * owner assertion. Neither should nag, and neither claims money moved —
 * `paidMinor` stays whatever the allocations actually say, which for a legacy
 * row is zero.
 */
export function deriveInstallmentBalance(
  installment: InstallmentFacts,
  now: Date,
  attentionWindowDays = 7,
): InstallmentBalance {
  const paid = sumActiveAllocations(installment.allocations);
  const scheduled = installment.scheduledAmountMinor;

  if (installment.status === "CANCELLED" || installment.status === "SETTLED_LEGACY") {
    return {
      scheduledMinor: scheduled,
      paidMinor: paid,
      remainingMinor: 0,
      state: installment.status,
    };
  }

  const remaining = scheduled - paid;
  let state: DerivedInstallmentState;
  if (remaining <= 0) {
    state = "PAID";
  } else if (paid > 0) {
    state = "PARTIALLY_PAID";
  } else if (installment.dueAt.getTime() < now.getTime()) {
    state = "OVERDUE";
  } else if (
    installment.dueAt.getTime() <=
    now.getTime() + attentionWindowDays * 24 * 60 * 60 * 1000
  ) {
    state = "DUE";
  } else {
    state = "SCHEDULED";
  }

  // An OVERDUE installment that is also partly paid reads as PARTIALLY_PAID
  // above; that is deliberate — "you still owe 6,000 of this" is the more
  // useful statement than "it is late", and lateness is still visible from
  // `dueAt`.
  return { scheduledMinor: scheduled, paidMinor: paid, remainingMinor: remaining, state };
}

export type CommitmentBalance = {
  /** NULL for open-ended RECURRING commitments — they have no total. */
  totalMinor: number | null;
  paidMinor: number;
  /** NULL when there is no total to subtract from. */
  remainingMinor: number | null;
};

/**
 * Roll a commitment up from its installments.
 *
 * A RECURRING commitment with no `totalAmount` must NOT be given an invented
 * one. Summing the installments that happen to exist today would answer a
 * different question — "what is scheduled so far" — and presenting that as a
 * remaining balance would be a lie that compounds every month. `remainingMinor`
 * is null and callers show the next installment instead.
 */
export function deriveCommitmentBalance(
  commitment: { totalAmountMinor: number | null; scheduleKind: CommitmentScheduleKindValue },
  installments: InstallmentFacts[],
  now: Date,
): CommitmentBalance {
  const paid = installments.reduce(
    (total, i) => total + sumActiveAllocations(i.allocations),
    0,
  );

  if (commitment.totalAmountMinor === null) {
    return { totalMinor: null, paidMinor: paid, remainingMinor: null };
  }

  const remaining = installments.reduce(
    (total, i) => total + deriveInstallmentBalance(i, now).remainingMinor,
    0,
  );

  return { totalMinor: commitment.totalAmountMinor, paidMinor: paid, remainingMinor: remaining };
}

/* ───────────────────────────── schedule generation ───────────────────────── */

export function addMonthsClamped(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return d;
}

export function nextOccurrence(from: Date, cadence: RecurrenceCadenceValue): Date | null {
  switch (cadence) {
    case "WEEKLY":
      return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    case "MONTHLY":
      return addMonthsClamped(from, 1);
    case "YEARLY":
      return addMonthsClamped(from, 12);
    default:
      return null;
  }
}

export type PlannedInstallment = { sequence: number; amountMinor: number; dueAt: Date };

/**
 * Split a finite plan into N installments whose amounts sum EXACTLY to the total.
 *
 * The remainder from an uneven division goes to the LAST installment. 7,000 / 3
 * becomes 2333.33 + 2333.33 + 2333.34 — never 3 × 2333.33, which would lose a
 * agora and break the finite-plan invariant the moment it was checked.
 */
export function generateInstallmentPlan(params: {
  totalMinor: number;
  count: number;
  firstDueAt: Date;
  cadence: Exclude<RecurrenceCadenceValue, "NONE">;
}): PlannedInstallment[] {
  const { totalMinor, count, firstDueAt, cadence } = params;
  assertPositiveAmount(totalMinor, "totalAmount");
  if (!Number.isInteger(count) || count < 1) {
    throw new PayablesValidationError("Installment count must be a positive integer");
  }
  if (count > totalMinor) {
    throw new PayablesValidationError(
      "Cannot split an amount into more installments than it has minor units",
    );
  }

  const base = Math.floor(totalMinor / count);
  const remainder = totalMinor - base * count;

  const out: PlannedInstallment[] = [];
  for (let i = 0; i < count; i += 1) {
    const dueAt =
      i === 0
        ? new Date(firstDueAt.getTime())
        : (nextOccurrenceN(firstDueAt, cadence, i) as Date);
    out.push({
      sequence: i + 1,
      amountMinor: i === count - 1 ? base + remainder : base,
      dueAt,
    });
  }
  return out;
}

function nextOccurrenceN(from: Date, cadence: RecurrenceCadenceValue, steps: number): Date | null {
  if (cadence === "WEEKLY") return new Date(from.getTime() + steps * 7 * 24 * 60 * 60 * 1000);
  if (cadence === "MONTHLY") return addMonthsClamped(from, steps);
  if (cadence === "YEARLY") return addMonthsClamped(from, steps * 12);
  return null;
}

/**
 * The finite-plan invariant (programme Invariant 14).
 *
 * For INSTALLMENT_PLAN and ONE_OFF, the scheduled amounts must sum exactly to
 * the commitment total. RECURRING has no total and is exempt — checking it
 * would require inventing one.
 */
export function assertFinitePlanIntegrity(params: {
  scheduleKind: CommitmentScheduleKindValue;
  totalMinor: number | null;
  installmentAmountsMinor: number[];
}): void {
  const { scheduleKind, totalMinor, installmentAmountsMinor } = params;
  if (scheduleKind === "RECURRING") {
    if (totalMinor !== null) {
      throw new PayablesValidationError(
        "A RECURRING commitment must not carry a total amount — it has no end",
      );
    }
    return;
  }
  if (totalMinor === null) {
    throw new PayablesValidationError(
      `A ${scheduleKind} commitment must carry a total amount`,
    );
  }
  const sum = installmentAmountsMinor.reduce((a, b) => a + b, 0);
  if (sum !== totalMinor) {
    throw new PayablesValidationError(
      `Installments sum to ${fromMinorUnits(sum)} but the commitment total is ${fromMinorUnits(totalMinor)}`,
    );
  }
}

/* ──────────────────────────── allocation planning ────────────────────────── */

export type AllocationTarget = {
  installmentId: number;
  remainingMinor: number;
  dueAt: Date;
  status: InstallmentStatusValue;
  currency: string;
};

export type PlannedAllocation = { installmentId: number; amountMinor: number };

export type AllocationPlan = {
  allocations: PlannedAllocation[];
  /** What the payment could not legally settle. Surfaced, never auto-applied. */
  unallocatedMinor: number;
};

/**
 * Decide how a payment is applied across installments.
 *
 * OVERPAYMENT IS REFUSED (owner decision 5). Each installment receives at most
 * its own remaining balance; whatever the payment cannot legally settle stays
 * `unallocatedMinor` and is surfaced to the owner. It is never silently applied
 * to something else, and no remaining balance is ever driven negative.
 *
 * Targets are consumed in due-date order, which is what an owner means by
 * "put this against what I owe".
 */
export function planAllocation(params: {
  paymentAmountMinor: number;
  paymentCurrency: string;
  targets: AllocationTarget[];
}): AllocationPlan {
  const { paymentAmountMinor, paymentCurrency, targets } = params;
  assertPositiveAmount(paymentAmountMinor, "payment amount");

  const eligible = targets
    .filter((t) => {
      if (t.status !== "SCHEDULED") return false; // CANCELLED / SETTLED_LEGACY take nothing
      if (t.remainingMinor <= 0) return false;
      if (t.currency !== paymentCurrency) {
        throw new PayablesValidationError(
          `Currency mismatch: payment is ${paymentCurrency}, installment is ${t.currency}`,
        );
      }
      return true;
    })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  let left = paymentAmountMinor;
  const allocations: PlannedAllocation[] = [];

  for (const target of eligible) {
    if (left <= 0) break;
    const amount = Math.min(left, target.remainingMinor);
    allocations.push({ installmentId: target.installmentId, amountMinor: amount });
    left -= amount;
  }

  return { allocations, unallocatedMinor: left };
}

/**
 * The guard a single allocation must pass before it is written.
 *
 * Called inside the same transaction that reads the remaining balance, so the
 * check and the write cannot be separated by a concurrent allocation. On its
 * own this function is only arithmetic; the serialization is the caller's job
 * (see `payables.service.ts`).
 */
export function assertAllocationAllowed(params: {
  amountMinor: number;
  installmentRemainingMinor: number;
  installmentStatus: InstallmentStatusValue;
  paymentUnallocatedMinor: number;
  paymentStatus: PaymentStatusValue;
  commitmentStatus: "ACTIVE" | "CLOSED" | "RELEASED";
  paymentCurrency: string;
  installmentCurrency: string;
}): void {
  const {
    amountMinor,
    installmentRemainingMinor,
    installmentStatus,
    paymentUnallocatedMinor,
    paymentStatus,
    commitmentStatus,
    paymentCurrency,
    installmentCurrency,
  } = params;

  assertPositiveAmount(amountMinor, "allocation amount");

  if (paymentStatus !== "RECORDED") {
    throw new PayablesValidationError("A voided payment cannot be allocated");
  }
  if (installmentStatus !== "SCHEDULED") {
    throw new PayablesValidationError(
      `A ${installmentStatus} installment cannot receive an allocation`,
    );
  }
  if (commitmentStatus !== "ACTIVE") {
    throw new PayablesValidationError(
      `A ${commitmentStatus} commitment cannot receive an allocation`,
    );
  }
  if (paymentCurrency !== installmentCurrency) {
    throw new PayablesValidationError(
      `Currency mismatch: payment is ${paymentCurrency}, installment is ${installmentCurrency}`,
    );
  }
  if (amountMinor > installmentRemainingMinor) {
    throw new PayablesValidationError(
      `Overpayment refused: allocating ${fromMinorUnits(amountMinor)} to an installment with ${fromMinorUnits(installmentRemainingMinor)} remaining`,
    );
  }
  if (amountMinor > paymentUnallocatedMinor) {
    throw new PayablesValidationError(
      `Over-allocation refused: allocating ${fromMinorUnits(amountMinor)} from a payment with ${fromMinorUnits(paymentUnallocatedMinor)} unallocated`,
    );
  }
}

/** Cancelling an installment that holds real money would strand it. */
export function assertInstallmentCancellable(params: {
  status: InstallmentStatusValue;
  activeAllocationCount: number;
}): void {
  if (params.status !== "SCHEDULED") {
    throw new PayablesValidationError(`Cannot cancel a ${params.status} installment`);
  }
  if (params.activeAllocationCount > 0) {
    throw new PayablesValidationError(
      "Cannot cancel an installment that has active allocations — reverse them first",
    );
  }
}
