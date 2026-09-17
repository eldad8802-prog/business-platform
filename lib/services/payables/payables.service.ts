/**
 * Payables service — Phase 1a.
 *
 * Loads rows, applies `payables-core` (which holds every accounting decision and
 * knows nothing about Prisma), and writes. Every mutation runs inside ONE tenant
 * transaction so a half-written ledger is not reachable: a commitment with only
 * some of its installments, or a payment whose allocation never landed, would
 * both be worse than a failed request.
 *
 * `businessId` always arrives from the caller's authenticated context and is
 * never read from a request body, matching every other tenant service here.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  assertAllocationAllowed,
  assertFinitePlanIntegrity,
  assertInstallmentCancellable,
  assertPositiveAmount,
  deriveCommitmentBalance,
  deriveInstallmentBalance,
  fromMinorUnits,
  generateInstallmentPlan,
  nextOccurrence,
  PayablesValidationError,
  planAllocation,
  sumActiveAllocations,
  toMinorUnits,
  type AllocationTarget,
  type CommitmentScheduleKindValue,
  type InstallmentFacts,
  type RecurrenceCadenceValue,
} from "@/lib/services/payables/payables-core";

type Tx = Prisma.TransactionClient;

export class PayablesNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayablesNotFoundError";
  }
}

/* ────────────────────────────────── audit ────────────────────────────────── */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Mirrors the billing audit hasher: stable JSON, then sha256. */
function hashAuditEvent(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

export type PayablesAuditType =
  | "COMMITMENT_CREATED"
  | "COMMITMENT_RELEASED"
  | "COMMITMENT_CLOSED"
  | "INSTALLMENT_CREATED"
  | "INSTALLMENT_CANCELLED"
  | "PAYMENT_RECORDED"
  | "PAYMENT_VOIDED"
  | "ALLOCATION_CREATED"
  | "ALLOCATION_REVERSED";

async function writeAudit(
  tx: Tx,
  input: {
    businessId: number;
    eventType: PayablesAuditType;
    summary: string;
    actorUserId?: number | null;
    commitmentId?: number | null;
    installmentId?: number | null;
    paymentId?: number | null;
    allocationId?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const occurredAt = new Date();
  await tx.payablesAuditEvent.create({
    data: {
      businessId: input.businessId,
      commitmentId: input.commitmentId ?? null,
      installmentId: input.installmentId ?? null,
      paymentId: input.paymentId ?? null,
      allocationId: input.allocationId ?? null,
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      source: "USER",
      summary: input.summary,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      eventHash: hashAuditEvent({
        businessId: input.businessId,
        eventType: input.eventType,
        summary: input.summary,
        commitmentId: input.commitmentId ?? null,
        paymentId: input.paymentId ?? null,
        allocationId: input.allocationId ?? null,
        actorUserId: input.actorUserId ?? null,
        metadata: input.metadata ?? null,
        occurredAt: occurredAt.toISOString(),
      }),
      occurredAt,
    },
  });
}

/* ────────────────────────────────── payee ────────────────────────────────── */

export type PayeeKindValue =
  | "SUPPLIER"
  | "AUTHORITY"
  | "UTILITY"
  | "LANDLORD"
  | "EMPLOYEE"
  | "LENDER"
  | "INSURER"
  | "OTHER";

export async function createPayee(input: {
  businessId: number;
  displayName: string;
  kind?: PayeeKindValue;
  legalName?: string | null;
  taxId?: string | null;
  note?: string | null;
}) {
  const displayName = input.displayName?.trim();
  if (!displayName) throw new PayablesValidationError("Payee name is required");

  return withTenantTransaction((tx) =>
    tx.payee.create({
      data: {
        businessId: input.businessId,
        displayName,
        kind: (input.kind ?? "OTHER") as never,
        legalName: input.legalName?.trim() || null,
        taxId: input.taxId?.trim() || null,
        note: input.note?.trim() || null,
      },
    }),
  );
}

export async function listPayees(input: { businessId: number; query?: string | null }) {
  return withTenantTransaction((tx) =>
    tx.payee.findMany({
      where: {
        businessId: input.businessId,
        isActive: true,
        ...(input.query?.trim()
          ? { displayName: { contains: input.query.trim(), mode: "insensitive" as const } }
          : {}),
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: 50,
    }),
  );
}

/* ──────────────────────────────── commitment ─────────────────────────────── */

export type CreateCommitmentInput = {
  businessId: number;
  actorUserId?: number | null;
  title: string;
  category?: string | null;
  payeeId?: number | null;
  payeeNameSnapshot?: string | null;
  currency?: string;
  scheduleKind: CommitmentScheduleKindValue;
  /** ONE_OFF / INSTALLMENT_PLAN: required. RECURRING: must be omitted. */
  totalAmount?: string | number | null;
  /** RECURRING: the amount of each occurrence. */
  recurringAmount?: string | number | null;
  installmentCount?: number | null;
  recurrence?: RecurrenceCadenceValue;
  firstDueAt: Date;
  defaultPaymentMethod?: string | null;
  note?: string | null;
};

/**
 * Create a commitment together with the installments it implies, atomically.
 *
 * ONE_OFF           → 1 installment for the whole total.
 * INSTALLMENT_PLAN  → N installments generated up front, summing EXACTLY to the
 *                     total (the remainder lands on the last one).
 * RECURRING         → exactly ONE installment, for the next due date. The rest
 *                     are materialised on settlement. An open-ended commitment
 *                     has no total and no last installment, so pre-generating a
 *                     schedule would mean inventing an end date.
 */
export async function createCommitment(input: CreateCommitmentInput) {
  const title = input.title?.trim();
  if (!title) throw new PayablesValidationError("Commitment title is required");

  const currency = (input.currency ?? "ILS").trim().toUpperCase();
  const recurrence: RecurrenceCadenceValue = input.recurrence ?? "NONE";

  return withTenantTransaction(async (tx) => {
    // The snapshot is resolved once, here, and never mutated afterwards.
    let payeeNameSnapshot = input.payeeNameSnapshot?.trim() || "";
    if (input.payeeId != null) {
      const payee = await tx.payee.findFirst({
        where: { id: input.payeeId, businessId: input.businessId },
        select: { id: true, displayName: true },
      });
      // Also the cross-tenant guard: a payee of another business is simply not
      // found under this tenant context, so it can never be linked.
      if (!payee) throw new PayablesNotFoundError("Payee not found");
      payeeNameSnapshot = payee.displayName;
    }
    if (!payeeNameSnapshot) {
      throw new PayablesValidationError("A payee name is required");
    }

    let totalMinor: number | null = null;
    let planned: Array<{ sequence: number; amountMinor: number; dueAt: Date }>;

    if (input.scheduleKind === "RECURRING") {
      if (input.totalAmount != null) {
        throw new PayablesValidationError(
          "A RECURRING commitment must not carry a total amount — it has no end",
        );
      }
      if (recurrence === "NONE") {
        throw new PayablesValidationError("A RECURRING commitment needs a cadence");
      }
      const each = toMinorUnits(input.recurringAmount ?? "0");
      assertPositiveAmount(each, "recurring amount");
      planned = [{ sequence: 1, amountMinor: each, dueAt: input.firstDueAt }];
    } else if (input.scheduleKind === "ONE_OFF") {
      totalMinor = toMinorUnits(input.totalAmount ?? "0");
      assertPositiveAmount(totalMinor, "total amount");
      planned = [{ sequence: 1, amountMinor: totalMinor, dueAt: input.firstDueAt }];
    } else {
      totalMinor = toMinorUnits(input.totalAmount ?? "0");
      assertPositiveAmount(totalMinor, "total amount");
      const count = input.installmentCount ?? 0;
      if (!Number.isInteger(count) || count < 2) {
        throw new PayablesValidationError(
          "An installment plan needs at least 2 installments",
        );
      }
      if (recurrence === "NONE") {
        throw new PayablesValidationError("An installment plan needs a cadence");
      }
      planned = generateInstallmentPlan({
        totalMinor,
        count,
        firstDueAt: input.firstDueAt,
        cadence: recurrence,
      });
    }

    // Invariant 14, checked before anything is written.
    assertFinitePlanIntegrity({
      scheduleKind: input.scheduleKind,
      totalMinor,
      installmentAmountsMinor: planned.map((p) => p.amountMinor),
    });

    const commitment = await tx.commitment.create({
      data: {
        businessId: input.businessId,
        title,
        category: input.category?.trim() || null,
        payeeId: input.payeeId ?? null,
        payeeNameSnapshot,
        currency,
        totalAmount: totalMinor === null ? null : new Prisma.Decimal(fromMinorUnits(totalMinor)),
        scheduleKind: input.scheduleKind as never,
        recurrence,
        defaultPaymentMethod: (input.defaultPaymentMethod ?? null) as never,
        startAt: input.firstDueAt,
        note: input.note?.trim() || null,
      },
    });

    await tx.installment.createMany({
      data: planned.map((p) => ({
        businessId: input.businessId,
        commitmentId: commitment.id,
        sequence: p.sequence,
        scheduledAmount: new Prisma.Decimal(fromMinorUnits(p.amountMinor)),
        currency,
        dueAt: p.dueAt,
      })),
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      eventType: "COMMITMENT_CREATED",
      summary: `Commitment "${title}" created with ${planned.length} installment(s)`,
      metadata: {
        scheduleKind: input.scheduleKind,
        installmentCount: planned.length,
        totalAmount: totalMinor === null ? null : fromMinorUnits(totalMinor),
        currency,
      },
    });

    return commitment;
  });
}

/* ───────────────────────────── derived read model ────────────────────────── */

function toFacts(installment: {
  scheduledAmount: Prisma.Decimal;
  dueAt: Date;
  status: string;
  allocations: Array<{
    allocatedAmount: Prisma.Decimal;
    reversedAt: Date | null;
    payment: { status: string };
  }>;
}): InstallmentFacts {
  return {
    scheduledAmountMinor: toMinorUnits(installment.scheduledAmount.toString()),
    dueAt: installment.dueAt,
    status: installment.status as InstallmentFacts["status"],
    allocations: installment.allocations.map((a) => ({
      allocatedAmountMinor: toMinorUnits(a.allocatedAmount.toString()),
      reversedAt: a.reversedAt,
      payment: { status: a.payment.status as "RECORDED" | "VOID" },
    })),
  };
}

/**
 * The commitment as the owner should see it. Every figure here is computed from
 * `PaymentAllocation.allocatedAmount` at read time — nothing is cached, so there
 * is no state that can disagree with the allocations.
 */
export async function getCommitmentBalance(input: {
  businessId: number;
  commitmentId: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return withTenantTransaction(async (tx) => {
    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      include: {
        installments: {
          orderBy: { sequence: "asc" },
          include: {
            allocations: { include: { payment: { select: { status: true } } } },
          },
        },
      },
    });
    if (!commitment) throw new PayablesNotFoundError("Commitment not found");

    const facts = commitment.installments.map(toFacts);
    const rollup = deriveCommitmentBalance(
      {
        totalAmountMinor:
          commitment.totalAmount === null
            ? null
            : toMinorUnits(commitment.totalAmount.toString()),
        scheduleKind: commitment.scheduleKind as CommitmentScheduleKindValue,
      },
      facts,
      now,
    );

    return {
      commitment,
      total: rollup.totalMinor === null ? null : fromMinorUnits(rollup.totalMinor),
      paid: fromMinorUnits(rollup.paidMinor),
      remaining: rollup.remainingMinor === null ? null : fromMinorUnits(rollup.remainingMinor),
      installments: commitment.installments.map((row, i) => {
        const b = deriveInstallmentBalance(facts[i], now);
        return {
          id: row.id,
          sequence: row.sequence,
          dueAt: row.dueAt,
          scheduled: fromMinorUnits(b.scheduledMinor),
          paid: fromMinorUnits(b.paidMinor),
          remaining: fromMinorUnits(b.remainingMinor),
          state: b.state,
        };
      }),
    };
  });
}

/* ─────────────────────────────── manual payment ──────────────────────────── */

export type RecordManualPaymentInput = {
  businessId: number;
  actorUserId?: number | null;
  commitmentId: number;
  amount: string | number;
  paidAt: Date;
  method: string;
  externalReference?: string | null;
  note?: string | null;
  /** A retry of the same logical request must not create a second Payment. */
  idempotencyKey?: string | null;
  /** Restrict application to specific installments; default is due-date order. */
  installmentIds?: number[] | null;
};

/**
 * Record that money left the business, and apply it.
 *
 * One transaction produces: Payment + PaymentEvidence(MANUAL) + N allocations +
 * audit events. Overpayment is refused — any amount the payment cannot legally
 * settle is returned as `unallocated` and surfaced, never applied elsewhere.
 */
export async function recordManualPayment(input: RecordManualPaymentInput) {
  const amountMinor = toMinorUnits(input.amount);
  assertPositiveAmount(amountMinor, "payment amount");

  return withTenantTransaction(async (tx) => {
    // Idempotency first: a retry returns the original economic event rather
    // than creating a second one. Checked inside the transaction so two
    // simultaneous retries cannot both pass it.
    if (input.idempotencyKey) {
      const existing = await tx.payment.findFirst({
        where: { businessId: input.businessId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        const allocations = await tx.paymentAllocation.findMany({
          where: { businessId: input.businessId, paymentId: existing.id },
        });
        return { payment: existing, allocations, unallocated: null, replayed: true };
      }
    }

    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      select: {
        id: true,
        status: true,
        currency: true,
        payeeId: true,
        payeeNameSnapshot: true,
      },
    });
    if (!commitment) throw new PayablesNotFoundError("Commitment not found");
    if (commitment.status !== "ACTIVE") {
      throw new PayablesValidationError(
        `A ${commitment.status} commitment cannot receive a payment`,
      );
    }

    // ── the concurrency guard ────────────────────────────────────────────────
    // Lock the commitment's installment rows before reading their balances, so
    // two concurrent payments cannot both observe the same remaining amount and
    // each allocate it. The lock is on the Installment rows rather than the
    // allocation rows because the allocations being guarded do not exist yet —
    // there is nothing to lock until the row that owns the balance is held.
    // Ordered by id so two transactions touching the same set cannot deadlock.
    await tx.$queryRaw`
      SELECT "id" FROM "Installment"
      WHERE "commitmentId" = ${input.commitmentId}
        AND "businessId" = ${input.businessId}
      ORDER BY "id"
      FOR UPDATE
    `;

    const installments = await tx.installment.findMany({
      where: {
        commitmentId: input.commitmentId,
        businessId: input.businessId,
        ...(input.installmentIds?.length ? { id: { in: input.installmentIds } } : {}),
      },
      include: { allocations: { include: { payment: { select: { status: true } } } } },
      orderBy: { dueAt: "asc" },
    });

    const targets: AllocationTarget[] = installments.map((row) => {
      const facts = toFacts(row);
      return {
        installmentId: row.id,
        remainingMinor: deriveInstallmentBalance(facts, input.paidAt).remainingMinor,
        dueAt: row.dueAt,
        status: facts.status,
        currency: row.currency,
      };
    });

    const plan = planAllocation({
      paymentAmountMinor: amountMinor,
      paymentCurrency: commitment.currency,
      targets,
    });

    const payment = await tx.payment.create({
      data: {
        businessId: input.businessId,
        payeeId: commitment.payeeId,
        payeeNameSnapshot: commitment.payeeNameSnapshot,
        amount: new Prisma.Decimal(fromMinorUnits(amountMinor)),
        currency: commitment.currency,
        paidAt: input.paidAt,
        method: input.method as never,
        externalReference: input.externalReference?.trim() || null,
        idempotencyKey: input.idempotencyKey?.trim() || null,
        createdByUserId: input.actorUserId ?? null,
      },
    });

    // Provenance from the first moment. A manual payment is the OWNER asserting
    // that money moved — it is evidence, and it is labelled as that kind.
    await tx.paymentEvidence.create({
      data: {
        businessId: input.businessId,
        paymentId: payment.id,
        kind: "MANUAL" as never,
        note: input.note?.trim() || null,
        assertedByUserId: input.actorUserId ?? null,
      },
    });

    let unallocatedMinor = amountMinor;
    const created = [];
    for (const allocation of plan.allocations) {
      const target = targets.find((t) => t.installmentId === allocation.installmentId);
      if (!target) continue;
      assertAllocationAllowed({
        amountMinor: allocation.amountMinor,
        installmentRemainingMinor: target.remainingMinor,
        installmentStatus: target.status,
        paymentUnallocatedMinor: unallocatedMinor,
        paymentStatus: "RECORDED",
        commitmentStatus: commitment.status as "ACTIVE",
        paymentCurrency: commitment.currency,
        installmentCurrency: target.currency,
      });
      const row = await tx.paymentAllocation.create({
        data: {
          businessId: input.businessId,
          paymentId: payment.id,
          installmentId: allocation.installmentId,
          allocatedAmount: new Prisma.Decimal(fromMinorUnits(allocation.amountMinor)),
          currency: commitment.currency,
          createdByUserId: input.actorUserId ?? null,
        },
      });
      unallocatedMinor -= allocation.amountMinor;
      created.push(row);
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: commitment.id,
        installmentId: allocation.installmentId,
        paymentId: payment.id,
        allocationId: row.id,
        eventType: "ALLOCATION_CREATED",
        summary: `Allocated ${fromMinorUnits(allocation.amountMinor)} ${commitment.currency}`,
        metadata: { allocatedAmount: fromMinorUnits(allocation.amountMinor) },
      });
    }

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      paymentId: payment.id,
      eventType: "PAYMENT_RECORDED",
      summary: `Manual payment of ${fromMinorUnits(amountMinor)} ${commitment.currency} recorded`,
      metadata: {
        amount: fromMinorUnits(amountMinor),
        unallocated: fromMinorUnits(unallocatedMinor),
        method: input.method,
      },
    });

    return {
      payment,
      allocations: created,
      unallocated: fromMinorUnits(unallocatedMinor),
      replayed: false,
    };
  });
}

/* ───────────────────────────── void and reversal ─────────────────────────── */

/**
 * Void a payment.
 *
 * Its allocation rows are deliberately NOT touched: one status flip invalidates
 * every one of them through the active predicate, whereas updating N rows could
 * half-succeed. History stays queryable; balances recompute on the next read.
 */
export async function voidPayment(input: {
  businessId: number;
  paymentId: number;
  actorUserId?: number | null;
  reason?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, businessId: input.businessId },
    });
    if (!payment) throw new PayablesNotFoundError("Payment not found");
    if (payment.status === "VOID") return payment; // idempotent

    const voided = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "VOID" as never,
        voidedAt: new Date(),
        voidedByUserId: input.actorUserId ?? null,
        voidReason: input.reason?.trim() || null,
      },
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      paymentId: payment.id,
      eventType: "PAYMENT_VOIDED",
      summary: `Payment voided`,
      metadata: { reason: input.reason ?? null },
    });

    return voided;
  });
}

/** Reverse ONE allocation, leaving the payment valid for its others. */
export async function reverseAllocation(input: {
  businessId: number;
  allocationId: number;
  actorUserId?: number | null;
  reason?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const allocation = await tx.paymentAllocation.findFirst({
      where: { id: input.allocationId, businessId: input.businessId },
    });
    if (!allocation) throw new PayablesNotFoundError("Allocation not found");
    if (allocation.reversedAt !== null) return allocation; // idempotent

    const reversed = await tx.paymentAllocation.update({
      where: { id: allocation.id },
      data: {
        reversedAt: new Date(),
        reversedByUserId: input.actorUserId ?? null,
        reversalReason: input.reason?.trim() || null,
      },
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      installmentId: allocation.installmentId,
      paymentId: allocation.paymentId,
      allocationId: allocation.id,
      eventType: "ALLOCATION_REVERSED",
      summary: `Allocation of ${allocation.allocatedAmount.toString()} reversed`,
      metadata: { reason: input.reason ?? null },
    });

    return reversed;
  });
}

/** Cancel a scheduled installment. Refused while it holds active allocations. */
export async function cancelInstallment(input: {
  businessId: number;
  installmentId: number;
  actorUserId?: number | null;
}) {
  return withTenantTransaction(async (tx) => {
    const installment = await tx.installment.findFirst({
      where: { id: input.installmentId, businessId: input.businessId },
      include: { allocations: { include: { payment: { select: { status: true } } } } },
    });
    if (!installment) throw new PayablesNotFoundError("Installment not found");

    const activeCount = installment.allocations.filter(
      (a) => a.reversedAt === null && a.payment.status === "RECORDED",
    ).length;

    assertInstallmentCancellable({
      status: installment.status as InstallmentFacts["status"],
      activeAllocationCount: activeCount,
    });

    const cancelled = await tx.installment.update({
      where: { id: installment.id },
      data: { status: "CANCELLED" as never, cancelledAt: new Date() },
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: installment.commitmentId,
      installmentId: installment.id,
      eventType: "INSTALLMENT_CANCELLED",
      summary: `Installment #${installment.sequence} cancelled`,
    });

    return cancelled;
  });
}

/* ───────────────────────── recurrence roll-forward ───────────────────────── */

/**
 * Materialise the next occurrence of a RECURRING commitment.
 *
 * Called when the current installment is fully settled. One at a time, never a
 * pre-generated horizon: an open-ended commitment has no last installment, so
 * any horizon would be an invented end date.
 */
export async function materialiseNextRecurringInstallment(input: {
  businessId: number;
  commitmentId: number;
  actorUserId?: number | null;
}) {
  return withTenantTransaction(async (tx) => {
    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      include: { installments: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!commitment) throw new PayablesNotFoundError("Commitment not found");
    if (commitment.scheduleKind !== "RECURRING") {
      throw new PayablesValidationError(
        "Only a RECURRING commitment rolls forward",
      );
    }
    if (commitment.status !== "ACTIVE") return null;

    const last = commitment.installments[0];
    if (!last) throw new PayablesValidationError("Commitment has no installments");

    const nextDue = nextOccurrence(last.dueAt, commitment.recurrence as RecurrenceCadenceValue);
    if (!nextDue) return null;

    const next = await tx.installment.create({
      data: {
        businessId: input.businessId,
        commitmentId: commitment.id,
        sequence: last.sequence + 1,
        scheduledAmount: last.scheduledAmount,
        currency: last.currency,
        dueAt: nextDue,
      },
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      installmentId: next.id,
      eventType: "INSTALLMENT_CREATED",
      summary: `Next recurring installment #${next.sequence} materialised`,
      metadata: { dueAt: nextDue.toISOString() },
    });

    return next;
  });
}

export { sumActiveAllocations, deriveInstallmentBalance, deriveCommitmentBalance };
