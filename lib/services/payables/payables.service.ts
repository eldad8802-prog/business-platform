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
  civilDayStart,
  deriveCommitmentBalance,
  deriveInstallmentBalance,
  fromMinorUnits,
  generateInstallmentPlan,
  nextDueAt,
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
  planAllocation,
  planAmountChange,
  planEnd,
  sumActiveAllocations,
  toMinorUnits,
  type AllocationTarget,
  type CommitmentScheduleKindValue,
  type InstallmentFacts,
  type RecurrenceCadenceValue,
} from "@/lib/services/payables/payables-core";

type Tx = Prisma.TransactionClient;

// Re-exported, not redeclared. Two classes of the same name in two modules look
// identical and silently fail `instanceof` against each other, so the read side
// and the write side share the single definition in `payables-core`.
export { PayablesNotFoundError } from "@/lib/services/payables/payables-core";

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
export function hashAuditEvent(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

export type PayablesAuditType =
  | "COMMITMENT_CREATED"
  | "COMMITMENT_UPDATED"
  | "COMMITMENT_RELEASED"
  | "COMMITMENT_CLOSED"
  | "INSTALLMENT_CREATED"
  | "INSTALLMENT_CANCELLED"
  // Phase 2 (secretary → ledger). A changed amount rewrites only occurrences
  // on or after its effective date; an end cancels only unpaid ones after it.
  | "INSTALLMENT_AMOUNT_CHANGED"
  | "COMMITMENT_ENDED"
  | "PAYMENT_RECORDED"
  | "PAYMENT_VOIDED"
  | "ALLOCATION_CREATED"
  | "ALLOCATION_REVERSED"
  // Phase 3. PayablesAuditEvent has no cheque or bank-account column, so the
  // ids travel in `metadata` — ids and last4 only, never coordinates.
  | "BANK_ACCOUNT_CREATED"
  | "BANK_ACCOUNT_RESTORED"
  | "BANK_ACCOUNT_UPDATED"
  | "BANK_ACCOUNT_DEFAULT_SET"
  | "BANK_ACCOUNT_ARCHIVED"
  | "CHEQUE_CREATED"
  | "CHEQUE_ADVANCED"
  | "CHEQUE_CLEARED_OWNER_ASSERTED"
  | "CHEQUE_BOUNCED"
  | "CHEQUE_CANCELLED"
  | "CHEQUE_REPLACED"
  // Phases 4–6. Ids travel in metadata; never coordinates, never fingerprints.
  | "DESTINATION_CREATED"
  | "DESTINATION_RESTORED"
  | "DESTINATION_UPDATED"
  | "DESTINATION_DEFAULT_SET"
  | "DESTINATION_ARCHIVED"
  | "DESTINATION_REPLACED"
  | "DESTINATION_REVEALED"
  | "PREPARATION_CREATED"
  | "PREPARATION_APPROVED"
  | "PREPARATION_CANCELLED"
  | "PREPARATION_COMPLETED"
  | "EXTERNAL_TRANSACTIONS_INGESTED"
  | "EXTERNAL_TRANSACTION_DISMISSED"
  | "EXTERNAL_TRANSACTION_ATTACHED"
  | "EXTERNAL_TRANSACTION_REJECTED"
  | "EXTERNAL_EVIDENCE_REVOKED"
  | "EXECUTION_REQUESTED"
  | "EXECUTION_UPDATED"
  | "EXECUTION_SETTLED"
  | "EXECUTION_FAILED"
  // M5.5. Ids and the kind enum only — never the payee's name, legal name or tax id.
  | "PAYEE_CREATED";

export async function writeAudit(
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
  /** Server-derived (the session user). Never read from a request body. */
  actorUserId?: number | null;
}) {
  const displayName = input.displayName?.trim();
  if (!displayName) throw new PayablesValidationError("Payee name is required");

  return withTenantTransaction(async (tx) => {
    const payee = await tx.payee.create({
      data: {
        businessId: input.businessId,
        displayName,
        kind: (input.kind ?? "OTHER") as never,
        legalName: input.legalName?.trim() || null,
        taxId: input.taxId?.trim() || null,
        note: input.note?.trim() || null,
      },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "PAYEE_CREATED",
      summary: `Payee #${payee.id} created`,
      metadata: { payeeId: payee.id, kind: payee.kind },
    });
    return payee;
  });
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
  /** Ties a recurring commitment into a series (the secretary always sets one). */
  recurrenceSeriesId?: string | null;
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
  return withTenantTransaction((tx) => createCommitmentInTx(tx, input));
}

/**
 * The body of `createCommitment`, inside a transaction the CALLER opened — the
 * secretary's ledger store runs in its route's tenant transaction and cannot
 * nest another. One implementation, so the secretary and the payables screen
 * can never create commitments by different rules.
 */
export async function createCommitmentInTx(tx: Tx, input: CreateCommitmentInput) {
  const title = input.title?.trim();
  if (!title) throw new PayablesValidationError("Commitment title is required");

  const currency = (input.currency ?? "ILS").trim().toUpperCase();
  const recurrence: RecurrenceCadenceValue = input.recurrence ?? "NONE";

  {
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
        recurrenceSeriesId: input.recurrenceSeriesId?.trim() || null,
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
  }
}

/* ───────────────────────────── derived read model ────────────────────────── */

export function toFacts(installment: {
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

/**
 * Edit a commitment — its DESCRIPTION, never its money.
 *
 * Title, note, category and the payee it names can all change: they describe
 * the commitment and correcting them corrects a mistake. The total, the
 * schedule kind, the cadence and the installment amounts deliberately cannot.
 * Installments already exist, payments may already be allocated against them,
 * and every balance on screen is derived from those rows — so "just" editing a
 * total would silently make a settled plan disagree with its own arithmetic.
 * Changing what is owed is a new commitment, or a cancellation and a
 * replacement, both of which stay visible in the ledger.
 *
 * Re-pointing the payee re-resolves the Tier-1 snapshot from the entity, and
 * free text remains legal: a commitment may name a payee that is not an entity
 * at all.
 */
export async function updateCommitment(input: {
  businessId: number;
  commitmentId: number;
  actorUserId?: number | null;
  title?: string;
  note?: string | null;
  category?: string | null;
  payeeId?: number | null;
  payeeNameSnapshot?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const existing = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      select: { id: true, title: true, payeeId: true, payeeNameSnapshot: true },
    });
    if (!existing) throw new PayablesNotFoundError("Commitment not found");

    const data: Prisma.CommitmentUpdateInput = {};

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new PayablesValidationError("Commitment title is required");
      data.title = title;
    }
    if (input.note !== undefined) data.note = input.note?.trim() || null;
    if (input.category !== undefined) data.category = input.category?.trim() || null;

    if (input.payeeId !== undefined) {
      if (input.payeeId === null) {
        // Detaching keeps the NAME. A commitment must never become anonymous,
        // so an explicit free-text name is required to replace the entity's.
        const snapshot = input.payeeNameSnapshot?.trim();
        if (!snapshot) {
          throw new PayablesValidationError(
            "A payee name is required when no payee entity is linked",
          );
        }
        data.payee = { disconnect: true };
        data.payeeNameSnapshot = snapshot;
      } else {
        const payee = await tx.payee.findFirst({
          where: { id: input.payeeId, businessId: input.businessId },
          select: { id: true, displayName: true },
        });
        // Cross-tenant guard: another business's payee is simply not found.
        if (!payee) throw new PayablesNotFoundError("Payee not found");
        data.payee = { connect: { id: payee.id } };
        data.payeeNameSnapshot = payee.displayName;
      }
    } else if (input.payeeNameSnapshot !== undefined && existing.payeeId === null) {
      const snapshot = input.payeeNameSnapshot?.trim();
      if (!snapshot) throw new PayablesValidationError("A payee name is required");
      data.payeeNameSnapshot = snapshot;
    }

    const updated = await tx.commitment.update({
      where: { id: existing.id },
      data,
    });

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: existing.id,
      eventType: "COMMITMENT_UPDATED",
      summary: `Commitment "${updated.title}" updated`,
      metadata: {
        changed: Object.keys(data),
        titleBefore: existing.title,
        payeeIdBefore: existing.payeeId,
      },
    });

    return updated;
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
  // Validated before a transaction is opened, so a malformed amount costs no
  // round trip. `recordPaymentInTx` validates again for its other callers.
  assertPositiveAmount(toMinorUnits(input.amount), "payment amount");
  return withTenantTransaction((tx) => recordPaymentInTx(tx, input));
}

/** Runs `fn` on a transaction the CALLER already opened (no nesting). */
function runInCallerTx<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return fn(tx);
}

/**
 * The body of `recordManualPayment`, runnable inside a caller's transaction.
 *
 * Exists so that a cleared cheque becomes a Payment through EXACTLY the same
 * allocation rules — the same lock, the same overpayment refusal, the same
 * idempotency — atomically with the cheque's own status change. A second copy
 * of this logic for cheques would be a second accounting universe.
 *
 * `evidence` defaults to MANUAL, which is what every Phase 1b caller meant.
 */
export async function recordPaymentInTx(
  outerTx: Tx,
  input: RecordManualPaymentInput & {
    evidence?: {
      kind: "MANUAL" | "CHEQUE" | "BANK_TRANSACTION" | "PAYMENT_PROVIDER";
      note?: string | null;
      /** Phase 5: the observed bank line this Payment is evidenced by. */
      externalTransactionId?: number | null;
    };
    auditSummary?: string;
  },
) {
  const amountMinor = toMinorUnits(input.amount);
  assertPositiveAmount(amountMinor, "payment amount");

  return runInCallerTx(outerTx, async (tx) => {
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
        scheduleKind: true,
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
        kind: (input.evidence?.kind ?? "MANUAL") as never,
        note: (input.evidence ? input.evidence.note?.trim() : input.note?.trim()) || null,
        externalTransactionId: input.evidence?.externalTransactionId ?? null,
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

    // Settling the LATEST occurrence of a recurring commitment brings the next
    // one into existence — what the payables screen has always promised
    // ("הבא אחריו ייווצר לאחר שיוסדר") and, until Phase 2, never did. Same
    // transaction, so a payment and the occurrence it unlocks land together.
    if (commitment.scheduleKind === "RECURRING" && created.length > 0) {
      const latest = await tx.installment.findFirst({
        where: { commitmentId: commitment.id, businessId: input.businessId },
        orderBy: { sequence: "desc" },
        include: { allocations: { include: { payment: { select: { status: true } } } } },
      });
      if (
        latest &&
        latest.status === "SCHEDULED" &&
        created.some((a) => a.installmentId === latest.id) &&
        deriveInstallmentBalance(toFacts(latest), input.paidAt).remainingMinor <= 0
      ) {
        await materialiseNextRecurringInstallmentInTx(tx, {
          businessId: input.businessId,
          commitmentId: commitment.id,
          actorUserId: input.actorUserId,
        });
      }
    }

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      paymentId: payment.id,
      eventType: "PAYMENT_RECORDED",
      summary:
        input.auditSummary ??
        `Manual payment of ${fromMinorUnits(amountMinor)} ${commitment.currency} recorded`,
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
  /**
   * Why the owner cancelled it. Optional, and deliberately audited rather than
   * stored on the installment: the row records WHAT it is now, the audit trail
   * records who decided that and why.
   */
  reason?: string | null;
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
      metadata: input.reason?.trim() ? { reason: input.reason.trim() } : null,
    });

    return cancelled;
  });
}

/* ───────────────────────── recurrence roll-forward ───────────────────────── */

/**
 * Materialise the next occurrence of a RECURRING commitment.
 *
 * One at a time, never a pre-generated horizon: an open-ended commitment has no
 * last installment, so any horizon would be an invented end date. Callers:
 * settling the latest occurrence (`recordPaymentInTx`), the secretary marking
 * one handled, and `changeRecurringAmountFrom` reaching its effective date.
 *
 * The due date comes from `nextDueAt` — anchored on the series' day and read in
 * Israel's calendar — so a materialised occurrence always lands exactly where
 * the Daily Business Cost engine had projected it. It never materialises past
 * the commitment's end date. The amount is the latest occurrence's, which is
 * how an amount change carries forward.
 */
export async function materialiseNextRecurringInstallment(input: {
  businessId: number;
  commitmentId: number;
  actorUserId?: number | null;
}) {
  return withTenantTransaction((tx) => materialiseNextRecurringInstallmentInTx(tx, input));
}

export async function materialiseNextRecurringInstallmentInTx(
  tx: Tx,
  input: { businessId: number; commitmentId: number; actorUserId?: number | null },
) {
  const commitment = await tx.commitment.findFirst({
    where: { id: input.commitmentId, businessId: input.businessId },
    include: { installments: { where: { businessId: input.businessId }, orderBy: { sequence: "asc" } } },
  });
  if (!commitment) throw new PayablesNotFoundError("Commitment not found");
  if (commitment.scheduleKind !== "RECURRING") {
    throw new PayablesValidationError("Only a RECURRING commitment rolls forward");
  }
  if (commitment.status !== "ACTIVE") return null;

  const first = commitment.installments[0];
  const last = commitment.installments[commitment.installments.length - 1];
  if (!first || !last) throw new PayablesValidationError("Commitment has no installments");

  const nextDue = nextDueAt({
    lastDueAt: last.dueAt,
    cadence: commitment.recurrence as RecurrenceCadenceValue,
    anchorDueAt: first.dueAt,
  });
  if (!nextDue) return null;
  if (commitment.endAt && nextDue.getTime() > civilDayStart(commitment.endAt).getTime()) return null;

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
}

/** Hard stop for a materialisation walk; a weekly commitment ten years out is ~520. */
const MAX_MATERIALISE_STEPS = 600;

/** Count of allocations that still hold money (the frozen active predicate). */
function activeAllocationCount(row: {
  allocations: Array<{ reversedAt: Date | null; payment: { status: string } }>;
}): number {
  return row.allocations.filter((a) => a.reversedAt === null && a.payment.status === "RECORDED").length;
}

/* ───────────────────────── amount change from a date ─────────────────────── */

/**
 * "From <date> the rent is 9,500" — change a RECURRING commitment's amount
 * without rewriting its history.
 *
 * The change starts at the first occurrence due on or after `effectiveFrom`.
 * Occurrences up to it are materialised first (so the new amount has a row to
 * live on), then every SCHEDULED occurrence from it on takes the new amount.
 * Nothing before it is touched: September keeps costing what September cost.
 * Later occurrences inherit the amount through materialisation, which copies
 * the latest one. Refused if any target already has a payment against it.
 */
export async function changeRecurringAmountFrom(input: {
  businessId: number;
  commitmentId: number;
  effectiveFrom: Date;
  amount: string | number;
  actorUserId?: number | null;
}) {
  const amountMinor = toMinorUnits(input.amount);
  assertPositiveAmount(amountMinor, "amount");
  return withTenantTransaction(async (tx) => {
    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      select: { id: true, title: true, scheduleKind: true, status: true, endAt: true },
    });
    if (!commitment) throw new PayablesNotFoundError("Commitment not found");
    if (commitment.scheduleKind !== "RECURRING") {
      throw new PayablesValidationError("Only a RECURRING commitment changes its amount from a date");
    }
    if (commitment.status !== "ACTIVE") {
      throw new PayablesValidationError(`A ${commitment.status} commitment cannot change its amount`);
    }
    const from = civilDayStart(input.effectiveFrom);
    if (commitment.endAt && from.getTime() > civilDayStart(commitment.endAt).getTime()) {
      throw new PayablesValidationError("The commitment ends before that date");
    }

    // Serialise with concurrent payments exactly as recordPaymentInTx does.
    await tx.$queryRaw`
      SELECT "id" FROM "Installment"
      WHERE "commitmentId" = ${commitment.id} AND "businessId" = ${input.businessId}
      ORDER BY "id" FOR UPDATE
    `;

    // Bring the first occurrence on/after the effective date into existence.
    for (let step = 0; step < MAX_MATERIALISE_STEPS; step += 1) {
      const last = await tx.installment.findFirst({
        where: { commitmentId: commitment.id, businessId: input.businessId },
        orderBy: { sequence: "desc" },
        select: { dueAt: true },
      });
      if (last && civilDayStart(last.dueAt).getTime() >= from.getTime()) break;
      const next = await materialiseNextRecurringInstallmentInTx(tx, {
        businessId: input.businessId,
        commitmentId: commitment.id,
        actorUserId: input.actorUserId,
      });
      if (!next) break;
    }

    const rows = await tx.installment.findMany({
      where: { commitmentId: commitment.id, businessId: input.businessId },
      include: { allocations: { include: { payment: { select: { status: true } } } } },
      orderBy: { sequence: "asc" },
    });
    const { targetIds } = planAmountChange({
      effectiveFrom: from,
      rows: rows.map((r) => ({
        id: r.id,
        dueAt: r.dueAt,
        status: r.status as InstallmentFacts["status"],
        activeAllocationCount: activeAllocationCount(r),
      })),
    });
    if (targetIds.length === 0) {
      throw new PayablesValidationError("No scheduled occurrence on or after that date");
    }

    const newAmount = new Prisma.Decimal(fromMinorUnits(amountMinor));
    for (const id of targetIds) {
      const before = rows.find((r) => r.id === id)!;
      await tx.installment.update({ where: { id }, data: { scheduledAmount: newAmount } });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: commitment.id,
        installmentId: id,
        eventType: "INSTALLMENT_AMOUNT_CHANGED",
        summary: `Installment #${before.sequence} amount changed from ${before.scheduledAmount.toString()} to ${fromMinorUnits(amountMinor)}`,
        metadata: {
          before: before.scheduledAmount.toString(),
          after: fromMinorUnits(amountMinor),
          effectiveFrom: from.toISOString(),
        },
      });
    }

    const first = rows.find((r) => r.id === targetIds[0])!;
    return {
      commitmentId: commitment.id,
      firstChangedInstallmentId: first.id,
      effectiveDueAt: first.dueAt,
      changedCount: targetIds.length,
    };
  });
}

/* ─────────────────────────────── end from a date ─────────────────────────── */

/**
 * "The contract ended on 31/12" — `endsOn` is the LAST day the commitment is in
 * effect (inclusive, Israel calendar), stored on `Commitment.endAt`.
 *
 * Unpaid occurrences due after it are cancelled; nothing is materialised past
 * it; the Daily Business Cost engine stops allocating after it. Status stays
 * ACTIVE, so an occurrence still owed for the final period can be paid. A paid
 * occurrence after the end date is refused rather than stranded.
 */
export async function endCommitment(input: {
  businessId: number;
  commitmentId: number;
  endsOn: Date;
  actorUserId?: number | null;
}) {
  return withTenantTransaction((tx) => endCommitmentInTx(tx, input));
}

export async function endCommitmentInTx(
  tx: Tx,
  input: { businessId: number; commitmentId: number; endsOn: Date; actorUserId?: number | null },
) {
  const commitment = await tx.commitment.findFirst({
    where: { id: input.commitmentId, businessId: input.businessId },
    select: { id: true, title: true, status: true, endAt: true },
  });
  if (!commitment) throw new PayablesNotFoundError("Commitment not found");
  if (commitment.status === "RELEASED") {
    throw new PayablesValidationError("A RELEASED commitment has nothing left to end");
  }
  const endsOn = civilDayStart(input.endsOn);

  await tx.$queryRaw`
    SELECT "id" FROM "Installment"
    WHERE "commitmentId" = ${commitment.id} AND "businessId" = ${input.businessId}
    ORDER BY "id" FOR UPDATE
  `;
  const rows = await tx.installment.findMany({
    where: { commitmentId: commitment.id, businessId: input.businessId },
    include: { allocations: { include: { payment: { select: { status: true } } } } },
    orderBy: { sequence: "asc" },
  });
  const firstDue = rows[0] ? civilDayStart(rows[0].dueAt) : null;
  if (firstDue && endsOn.getTime() < firstDue.getTime()) {
    throw new PayablesValidationError("The end date is before the commitment's first occurrence");
  }
  const { cancelIds } = planEnd({
    endsOn,
    rows: rows.map((r) => ({
      id: r.id,
      dueAt: r.dueAt,
      status: r.status as InstallmentFacts["status"],
      activeAllocationCount: activeAllocationCount(r),
    })),
  });

  const now = new Date();
  for (const id of cancelIds) {
    await tx.installment.update({ where: { id }, data: { status: "CANCELLED" as never, cancelledAt: now } });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      installmentId: id,
      eventType: "INSTALLMENT_CANCELLED",
      summary: `Installment cancelled — the commitment ends ${endsOn.toISOString().slice(0, 10)}`,
      metadata: { reason: "COMMITMENT_ENDED" },
    });
  }
  const updated = await tx.commitment.update({ where: { id: commitment.id }, data: { endAt: endsOn } });
  await writeAudit(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    commitmentId: commitment.id,
    eventType: "COMMITMENT_ENDED",
    summary: `Commitment "${commitment.title}" ends ${endsOn.toISOString().slice(0, 10)}`,
    metadata: {
      endsOn: endsOn.toISOString(),
      endAtBefore: commitment.endAt ? commitment.endAt.toISOString() : null,
      cancelledInstallments: cancelIds,
    },
  });
  return { commitment: updated, cancelledInstallmentIds: cancelIds };
}

/** Cancel a scheduled installment inside a caller's transaction (the secretary's release). */
export async function cancelInstallmentInTx(
  tx: Tx,
  input: { businessId: number; installmentId: number; actorUserId?: number | null; reason?: string | null },
) {
  const installment = await tx.installment.findFirst({
    where: { id: input.installmentId, businessId: input.businessId },
    include: { allocations: { include: { payment: { select: { status: true } } } } },
  });
  if (!installment) throw new PayablesNotFoundError("Installment not found");
  const activeCount = activeAllocationCount(installment);
  if (activeCount > 0) {
    throw new PayablesConflictError("This occurrence already has a payment against it — reverse it first");
  }
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
    metadata: input.reason?.trim() ? { reason: input.reason.trim() } : null,
  });
  return cancelled;
}

export { sumActiveAllocations, deriveInstallmentBalance, deriveCommitmentBalance };
