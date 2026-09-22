/**
 * "הכן תשלום" — Accounts Payable Phase 4.
 *
 * A PaymentPreparation is an intention: who is paid, how much, from where, to
 * where, for which obligation. Preparing, approving or cancelling one moves no
 * money and marks nothing paid — balances are still derived only from active
 * allocations on RECORDED Payments, and a preparation has none.
 *
 *   PREPARED ──approve──► APPROVED ──(owner reports it done)────────► COMPLETED
 *      │                     │   └──(provider executes, Phase 6)──► SUBMITTED ─► COMPLETED | FAILED
 *      └──cancel──► CANCELLED ◄──cancel──┘            (bank line observed, Phase 5) ─► COMPLETED
 *
 * # One convergence point
 *
 * Every way a preparation completes — the owner saying "I made the transfer", a
 * bank line observed and confirmed, a provider settling it — runs through
 * `completePreparationInTx`, which records ONE canonical Payment through the same
 * `recordPaymentInTx` a manual payment uses (same lock, same overpayment
 * refusal), keyed `prep:<id>`. `PaymentPreparation.paymentId` is UNIQUE in the
 * database: a preparation can never produce a second Payment.
 *
 * # The frozen snapshot
 *
 * Approval records a hash over amount, method, payee, obligation, source and
 * destination — including the destination's and source's keyed fingerprints.
 * Completion recomputes it from the CURRENT rows and refuses if anything moved:
 * a destination edited, replaced or archived after approval is never silently
 * paid.
 *
 * # Over-preparation
 *
 * The open preparations of one installment may not together exceed what it still
 * owes. Two approved transfers for the same bill is how businesses pay twice.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
  assertPositiveAmount,
  deriveInstallmentBalance,
  fromMinorUnits,
  toMinorUnits,
} from "@/lib/services/payables/payables-core";
import {
  approvalHash,
  assertDestinationRule,
  assertPreparableMethod,
  assertPreparationTransition,
  preparationActions,
  type ApprovalSnapshot,
  type CompletionSourceValue,
  type PreparationStatusValue,
} from "@/lib/services/payables/payables-p46-core";
import { maskAccount } from "@/lib/services/payables/payables-bank-crypto";
import { recordPaymentInTx, toFacts, writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

const OPEN_STATUSES = ["PREPARED", "APPROVED", "SUBMITTED", "FAILED"] as const;

export function preparationPaymentKey(preparationId: number): string {
  return `prep:${preparationId}`;
}

/* ───────────────────────────────── view ───────────────────────────────── */

const PREP_SELECT = {
  id: true,
  commitmentId: true,
  installmentId: true,
  payeeId: true,
  payeeNameSnapshot: true,
  amount: true,
  currency: true,
  method: true,
  sourceBankAccountId: true,
  destinationId: true,
  reference: true,
  note: true,
  status: true,
  approvedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  completedAt: true,
  completionSource: true,
  paymentId: true,
  createdAt: true,
  commitment: { select: { id: true, title: true } },
  installment: { select: { id: true, sequence: true, dueAt: true } },
  sourceBankAccount: { select: { id: true, label: true, accountLast4: true, isActive: true } },
  destination: {
    select: { id: true, label: true, beneficiaryName: true, accountLast4: true, isActive: true, verification: true },
  },
  executions: {
    select: { id: true, provider: true, status: true, providerReference: true, failureCode: true, requestedAt: true },
    orderBy: { id: "desc" as const },
    take: 5,
  },
} as const;

type PrepRow = Prisma.PaymentPreparationGetPayload<{ select: typeof PREP_SELECT }>;

export type PreparationView = {
  id: number;
  status: PreparationStatusValue;
  amount: string;
  currency: string;
  method: string;
  payee: { id: number | null; name: string };
  commitment: { id: number; title: string };
  installment: { id: number; sequence: number; dueAt: Date } | null;
  source: { id: number; label: string; masked: string; isActive: boolean } | null;
  destination: {
    id: number;
    label: string;
    beneficiaryName: string;
    masked: string;
    isActive: boolean;
    verification: string;
  } | null;
  reference: string | null;
  note: string | null;
  approvedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  completedAt: Date | null;
  completionSource: string | null;
  paymentId: number | null;
  executions: Array<{ id: number; provider: string; status: string; providerReference: string | null; failureCode: string | null; requestedAt: Date }>;
  createdAt: Date;
  actions: ReturnType<typeof preparationActions>;
};

function toView(row: PrepRow): PreparationView {
  const status = row.status as PreparationStatusValue;
  return {
    id: row.id,
    status,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    method: row.method,
    payee: { id: row.payeeId, name: row.payeeNameSnapshot },
    commitment: row.commitment,
    installment: row.installment,
    source: row.sourceBankAccount
      ? {
          id: row.sourceBankAccount.id,
          label: row.sourceBankAccount.label,
          masked: maskAccount(row.sourceBankAccount.accountLast4),
          isActive: row.sourceBankAccount.isActive,
        }
      : null,
    destination: row.destination
      ? {
          id: row.destination.id,
          label: row.destination.label,
          beneficiaryName: row.destination.beneficiaryName,
          masked: maskAccount(row.destination.accountLast4),
          isActive: row.destination.isActive,
          verification: row.destination.verification,
        }
      : null,
    reference: row.reference,
    note: row.note,
    approvedAt: row.approvedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    completedAt: row.completedAt,
    completionSource: row.completionSource,
    paymentId: row.paymentId,
    executions: row.executions,
    createdAt: row.createdAt,
    actions: preparationActions(status),
  };
}

async function viewOf(tx: Tx, businessId: number, id: number): Promise<PreparationView> {
  const row = await tx.paymentPreparation.findFirst({ where: { id, businessId }, select: PREP_SELECT });
  if (!row) throw new PayablesNotFoundError("Payment preparation not found");
  return toView(row);
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

function cleanText(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new PayablesValidationError(`${field} must be text`);
  const v = value.trim();
  if (v.length > max) throw new PayablesValidationError(`${field} must be at most ${max} characters`);
  return v || null;
}

async function lockPreparation(tx: Tx, businessId: number, id: number) {
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "PaymentPreparation" WHERE "id" = ${id} AND "businessId" = ${businessId} FOR UPDATE`;
  if (locked.length === 0) throw new PayablesNotFoundError("Payment preparation not found");
  const row = await tx.paymentPreparation.findFirst({ where: { id, businessId } });
  if (!row) throw new PayablesNotFoundError("Payment preparation not found");
  return row;
}

/** What the installment still owes right now, from active allocations only. */
async function installmentRemainingMinor(tx: Tx, businessId: number, installmentId: number): Promise<number> {
  const inst = await tx.installment.findFirst({
    where: { id: installmentId, businessId },
    include: { allocations: { include: { payment: { select: { status: true } } } } },
  });
  if (!inst) throw new PayablesNotFoundError("Installment not found");
  return deriveInstallmentBalance(toFacts(inst), new Date()).remainingMinor;
}

/**
 * The open (not completed, not cancelled) preparations already planned against
 * one installment, in minor units — excluding `exceptId` when re-checking one.
 */
async function openPreparedMinor(tx: Tx, businessId: number, installmentId: number, exceptId?: number) {
  const rows = await tx.paymentPreparation.findMany({
    where: {
      businessId,
      installmentId,
      status: { in: OPEN_STATUSES as unknown as never[] },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { amount: true },
  });
  return rows.reduce((sum, r) => sum + toMinorUnits(r.amount.toFixed(2)), 0);
}

async function assertWithinWhatIsOwed(
  tx: Tx,
  businessId: number,
  installmentId: number,
  amountMinor: number,
  exceptId?: number,
) {
  // Serialise preparations of one installment so two concurrent requests cannot
  // both pass this check.
  await tx.$queryRaw`SELECT "id" FROM "Installment" WHERE "id" = ${installmentId} AND "businessId" = ${businessId} FOR UPDATE`;
  const remaining = await installmentRemainingMinor(tx, businessId, installmentId);
  const planned = await openPreparedMinor(tx, businessId, installmentId, exceptId);
  if (amountMinor + planned > remaining) {
    throw new PayablesValidationError(
      planned > 0
        ? `Prepared payments for this installment would exceed what it still owes (${fromMinorUnits(remaining)}; already prepared ${fromMinorUnits(planned)})`
        : `The amount exceeds what this installment still owes (${fromMinorUnits(remaining)})`,
    );
  }
}

/** The current snapshot of a preparation, from the CURRENT rows. */
async function currentSnapshot(
  tx: Tx,
  prep: {
    id: number;
    businessId: number;
    commitmentId: number;
    installmentId: number | null;
    payeeId: number | null;
    amount: Prisma.Decimal;
    currency: string;
    method: string;
    destinationId: number | null;
    sourceBankAccountId: number | null;
    reference: string | null;
  },
): Promise<{ snapshot: ApprovalSnapshot; destinationActive: boolean; sourceActive: boolean }> {
  const destination = prep.destinationId
    ? await tx.paymentDestination.findFirst({
        where: { id: prep.destinationId, businessId: prep.businessId },
        select: { fingerprint: true, isActive: true, payeeId: true },
      })
    : null;
  const source = prep.sourceBankAccountId
    ? await tx.businessBankAccount.findFirst({
        where: { id: prep.sourceBankAccountId, businessId: prep.businessId },
        select: { fingerprint: true, isActive: true },
      })
    : null;
  return {
    snapshot: {
      preparationId: prep.id,
      businessId: prep.businessId,
      commitmentId: prep.commitmentId,
      installmentId: prep.installmentId,
      payeeId: prep.payeeId,
      amount: prep.amount.toFixed(2),
      currency: prep.currency,
      method: prep.method,
      destinationId: prep.destinationId,
      destinationFingerprint: destination?.fingerprint ?? null,
      sourceBankAccountId: prep.sourceBankAccountId,
      sourceFingerprint: source?.fingerprint ?? null,
      reference: prep.reference,
    },
    destinationActive: prep.destinationId ? destination?.isActive === true : true,
    sourceActive: prep.sourceBankAccountId ? source?.isActive === true : true,
  };
}

/**
 * Refuse unless what is about to be paid is EXACTLY what was approved. Returns
 * the frozen snapshot for callers (the execution layer) that must carry it.
 */
export async function assertFrozenSnapshotInTx(
  tx: Tx,
  prep: Parameters<typeof currentSnapshot>[1] & { approvalHash: string | null },
): Promise<ApprovalSnapshot> {
  if (!prep.approvalHash) throw new PayablesValidationError("This payment has not been approved");
  const { snapshot, destinationActive, sourceActive } = await currentSnapshot(tx, prep);
  if (!destinationActive) {
    throw new PayablesValidationError("The destination account was archived after approval; prepare the payment again");
  }
  if (!sourceActive) {
    throw new PayablesValidationError("The source account was archived after approval; prepare the payment again");
  }
  if (approvalHash(snapshot) !== prep.approvalHash) {
    throw new PayablesConflictError(
      "The payment details changed after approval; review and approve it again before paying",
    );
  }
  return snapshot;
}

/* ──────────────────────────────── reads ───────────────────────────────── */

export async function listPreparations(input: {
  businessId: number;
  commitmentId?: number | null;
  scope?: "open" | "all";
}): Promise<PreparationView[]> {
  return withTenantTransaction(async (tx) => {
    const rows = await tx.paymentPreparation.findMany({
      where: {
        businessId: input.businessId,
        ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
        ...(input.scope === "all" ? {} : { status: { in: OPEN_STATUSES as unknown as never[] } }),
      },
      select: PREP_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return rows.map(toView);
  });
}

export async function getPreparation(input: { businessId: number; preparationId: number }) {
  return withTenantTransaction((tx) => viewOf(tx, input.businessId, input.preparationId));
}

/* ──────────────────────────────── prepare ─────────────────────────────── */

export async function preparePayment(input: {
  businessId: number;
  actorUserId?: number | null;
  commitmentId: number;
  installmentId?: number | null;
  amount: string;
  method: unknown;
  destinationId?: number | null;
  sourceBankAccountId?: number | null;
  reference?: unknown;
  note?: unknown;
}): Promise<PreparationView> {
  assertPreparableMethod(input.method);
  const method = input.method;
  const destinationId = input.destinationId ?? null;
  assertDestinationRule(method, destinationId);
  const amountMinor = toMinorUnits(input.amount);
  assertPositiveAmount(amountMinor, "amount");
  const reference = cleanText(input.reference, "reference", 140);
  const note = cleanText(input.note, "note", 500);

  return withTenantTransaction(async (tx) => {
    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      select: { id: true, status: true, payeeId: true, payeeNameSnapshot: true, currency: true, scheduleKind: true },
    });
    if (!commitment) throw new PayablesNotFoundError("Commitment not found");
    if (commitment.status !== "ACTIVE") {
      throw new PayablesValidationError(`A ${commitment.status} commitment cannot be paid`);
    }

    let installmentId: number | null = null;
    if (input.installmentId) {
      const inst = await tx.installment.findFirst({
        where: { id: input.installmentId, businessId: input.businessId },
        select: { id: true, commitmentId: true, status: true },
      });
      if (!inst) throw new PayablesNotFoundError("Installment not found");
      if (inst.commitmentId !== commitment.id) {
        throw new PayablesValidationError("The installment does not belong to that commitment");
      }
      if (inst.status !== "SCHEDULED") {
        throw new PayablesValidationError(`A ${inst.status} installment cannot be paid`);
      }
      installmentId = inst.id;
      await assertWithinWhatIsOwed(tx, input.businessId, installmentId, amountMinor);
    } else if (commitment.scheduleKind === "RECURRING") {
      // An open-ended commitment has no total to measure against; a payment for
      // it has to name the occurrence it pays.
      throw new PayablesValidationError("A recurring commitment is paid one installment at a time");
    }

    if (destinationId) {
      const destination = await tx.paymentDestination.findFirst({
        where: { id: destinationId, businessId: input.businessId },
        select: { id: true, payeeId: true, isActive: true },
      });
      if (!destination) throw new PayablesNotFoundError("Destination not found");
      if (!destination.isActive) throw new PayablesValidationError("That destination account is archived");
      // No silent substitution: the money goes to an account of the payee this
      // commitment names, or nowhere.
      if (!commitment.payeeId || destination.payeeId !== commitment.payeeId) {
        throw new PayablesValidationError("The destination belongs to a different payee than this commitment");
      }
    }

    if (input.sourceBankAccountId) {
      const source = await tx.businessBankAccount.findFirst({
        where: { id: input.sourceBankAccountId, businessId: input.businessId },
        select: { id: true, isActive: true },
      });
      if (!source) throw new PayablesNotFoundError("Bank account not found");
      if (!source.isActive) throw new PayablesValidationError("That bank account is archived");
    }

    const row = await tx.paymentPreparation.create({
      data: {
        businessId: input.businessId,
        commitmentId: commitment.id,
        installmentId,
        payeeId: commitment.payeeId,
        payeeNameSnapshot: commitment.payeeNameSnapshot,
        amount: new Prisma.Decimal(fromMinorUnits(amountMinor)),
        currency: commitment.currency,
        method: method as never,
        destinationId,
        sourceBankAccountId: input.sourceBankAccountId ?? null,
        reference,
        note,
        createdByUserId: input.actorUserId ?? null,
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: commitment.id,
      installmentId,
      eventType: "PREPARATION_CREATED",
      summary: `Payment of ${fromMinorUnits(amountMinor)} ${commitment.currency} prepared (nothing paid)`,
      metadata: { preparationId: row.id, method, destinationId, sourceBankAccountId: input.sourceBankAccountId ?? null },
    });
    return viewOf(tx, input.businessId, row.id);
  });
}

/* ──────────────────────────────── approve ─────────────────────────────── */

export async function approvePreparation(input: {
  businessId: number;
  actorUserId?: number | null;
  preparationId: number;
}): Promise<PreparationView> {
  return withTenantTransaction(async (tx) => {
    const prep = await lockPreparation(tx, input.businessId, input.preparationId);
    if (prep.status === "APPROVED") return viewOf(tx, input.businessId, prep.id); // idempotent
    assertPreparationTransition(prep.status as PreparationStatusValue, "APPROVED");
    if (prep.installmentId) {
      await assertWithinWhatIsOwed(
        tx,
        input.businessId,
        prep.installmentId,
        toMinorUnits(prep.amount.toFixed(2)),
        prep.id,
      );
    }
    const { snapshot, destinationActive, sourceActive } = await currentSnapshot(tx, prep);
    if (!destinationActive) throw new PayablesValidationError("The destination account is archived");
    if (!sourceActive) throw new PayablesValidationError("The source account is archived");
    const hash = approvalHash(snapshot);
    await tx.paymentPreparation.update({
      where: { id: prep.id },
      data: {
        status: "APPROVED" as never,
        approvedAt: new Date(),
        approvedByUserId: input.actorUserId ?? null,
        approvalHash: hash,
        frozenDestinationFingerprint: snapshot.destinationFingerprint,
        frozenSourceFingerprint: snapshot.sourceFingerprint,
      },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: prep.commitmentId,
      installmentId: prep.installmentId,
      eventType: "PREPARATION_APPROVED",
      summary: `Prepared payment of ${prep.amount.toFixed(2)} ${prep.currency} approved by the owner (nothing paid yet)`,
      metadata: { preparationId: prep.id, destinationId: prep.destinationId },
    });
    return viewOf(tx, input.businessId, prep.id);
  });
}

/* ──────────────────────────────── cancel ──────────────────────────────── */

export async function cancelPreparation(input: {
  businessId: number;
  actorUserId?: number | null;
  preparationId: number;
  reason?: unknown;
}): Promise<PreparationView> {
  const reason = cleanText(input.reason, "reason", 500);
  return withTenantTransaction(async (tx) => {
    const prep = await lockPreparation(tx, input.businessId, input.preparationId);
    if (prep.status === "CANCELLED") return viewOf(tx, input.businessId, prep.id);
    assertPreparationTransition(prep.status as PreparationStatusValue, "CANCELLED");
    const live = await tx.outboundExecution.count({
      where: { businessId: input.businessId, preparationId: prep.id, status: { in: ["REQUESTED", "SUBMITTED", "ACKNOWLEDGED"] as never } },
    });
    if (live > 0) {
      throw new PayablesValidationError("A provider is still processing this payment; it cannot be cancelled here");
    }
    await tx.paymentPreparation.update({
      where: { id: prep.id },
      data: {
        status: "CANCELLED" as never,
        cancelledAt: new Date(),
        cancelledByUserId: input.actorUserId ?? null,
        cancellationReason: reason,
      },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: prep.commitmentId,
      installmentId: prep.installmentId,
      eventType: "PREPARATION_CANCELLED",
      summary: `Prepared payment cancelled (nothing had been paid)`,
      metadata: { preparationId: prep.id, from: prep.status, reason },
    });
    return viewOf(tx, input.businessId, prep.id);
  });
}

/* ─────────────────────────────── complete ─────────────────────────────── */

/**
 * The ONE convergence point: money moved, so the preparation becomes the
 * canonical Payment. Idempotent — a completed preparation returns its Payment.
 * Callers own the transaction and the lock; `evidence` says what proves it.
 */
export async function completePreparationInTx(
  tx: Tx,
  input: {
    businessId: number;
    actorUserId?: number | null;
    preparationId: number;
    paidAt: Date;
    source: CompletionSourceValue;
    externalReference?: string | null;
    evidence: { kind: "MANUAL" | "BANK_TRANSACTION" | "PAYMENT_PROVIDER"; note: string; externalTransactionId?: number | null };
  },
): Promise<{ paymentId: number; unallocated: string; replayed: boolean }> {
  const prep = await lockPreparation(tx, input.businessId, input.preparationId);
  if (prep.status === "COMPLETED" && prep.paymentId) {
    return { paymentId: prep.paymentId, unallocated: "0.00", replayed: true };
  }
  assertPreparationTransition(prep.status as PreparationStatusValue, "COMPLETED");
  await assertFrozenSnapshotInTx(tx, prep);
  if (input.paidAt.getTime() > Date.now() + 36 * 60 * 60 * 1000) {
    throw new PayablesValidationError("A payment cannot have been made in the future");
  }

  const commitment = await tx.commitment.findFirst({
    where: { id: prep.commitmentId, businessId: input.businessId },
    select: { status: true },
  });

  const amount = prep.amount.toFixed(2);
  const key = preparationPaymentKey(prep.id);
  let paymentId: number;
  let unallocated: string;

  // Exactly ONE evidence row, of the kind that actually proves it: MANUAL when
  // the owner asserts it, BANK_TRANSACTION (with the line) when the bank
  // observed it, PAYMENT_PROVIDER when a provider settled it.
  const evidence = {
    kind: input.evidence.kind,
    note: input.evidence.note,
    externalTransactionId: input.evidence.externalTransactionId ?? null,
  };
  if (commitment?.status === "ACTIVE") {
    const result = await recordPaymentInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: prep.commitmentId,
      amount,
      paidAt: input.paidAt,
      method: prep.method,
      externalReference: input.externalReference?.trim() || prep.reference,
      idempotencyKey: key,
      installmentIds: prep.installmentId ? [prep.installmentId] : null,
      evidence,
      auditSummary: `Prepared payment of ${amount} ${prep.currency} completed (${input.source})`,
    });
    paymentId = result.payment.id;
    unallocated = result.unallocated ?? "0.00";
  } else {
    const payment = await tx.payment.create({
      data: {
        businessId: input.businessId,
        payeeId: prep.payeeId,
        payeeNameSnapshot: prep.payeeNameSnapshot,
        amount: new Prisma.Decimal(amount),
        currency: prep.currency,
        paidAt: input.paidAt,
        method: prep.method,
        externalReference: input.externalReference?.trim() || prep.reference,
        idempotencyKey: key,
        createdByUserId: input.actorUserId ?? null,
      },
      select: { id: true },
    });
    await tx.paymentEvidence.create({
      data: {
        businessId: input.businessId,
        paymentId: payment.id,
        kind: evidence.kind as never,
        note: evidence.note,
        externalTransactionId: evidence.externalTransactionId,
        assertedByUserId: input.actorUserId ?? null,
      },
    });
    paymentId = payment.id;
    unallocated = amount;
  }

  await tx.paymentPreparation.update({
    where: { id: prep.id },
    data: {
      status: "COMPLETED" as never,
      completedAt: new Date(),
      completionSource: input.source as never,
      paymentId,
    },
  });
  await writeAudit(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    commitmentId: prep.commitmentId,
    installmentId: prep.installmentId,
    paymentId,
    eventType: "PREPARATION_COMPLETED",
    summary: `Prepared payment completed — ${input.source}`,
    metadata: { preparationId: prep.id, source: input.source, unallocated },
  });
  return { paymentId, unallocated, replayed: false };
}

/** The owner says: "I made this transfer." */
export async function reportPreparationCompleted(input: {
  businessId: number;
  actorUserId?: number | null;
  preparationId: number;
  paidAt: Date;
  externalReference?: string | null;
}): Promise<{ preparation: PreparationView; unallocated: string; replayed: boolean }> {
  return withTenantTransaction(async (tx) => {
    const result = await completePreparationInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      preparationId: input.preparationId,
      paidAt: input.paidAt,
      source: "OWNER_REPORTED",
      externalReference: input.externalReference ?? null,
      evidence: { kind: "MANUAL", note: "The owner reported making this prepared payment (owner-asserted, not bank-observed)" },
    });
    return {
      preparation: await viewOf(tx, input.businessId, input.preparationId),
      unallocated: result.unallocated,
      replayed: result.replayed,
    };
  });
}
