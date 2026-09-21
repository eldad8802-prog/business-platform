/**
 * Cheques — Accounts Payable Phase 3.
 *
 * Loads, asks `payables-cheque-core` what is allowed, writes, audits. Every
 * mutation is ONE tenant transaction holding a row lock on the cheque, so two
 * concurrent actions on the same cheque serialise instead of both passing the
 * lifecycle check.
 *
 * # A cleared cheque is ONE canonical Payment
 *
 * Clearing writes, atomically with the status change:
 *
 *   Payment (method CHECK, idempotencyKey "cheque:<id>")
 *     + PaymentEvidence (kind CHEQUE)
 *     + PaymentAllocation(s) — through `recordPaymentInTx`, the SAME code path a
 *       manual payment takes: same lock, same overpayment refusal
 *
 * The key is unique per business (`@@unique([businessId, idempotencyKey])`), so
 * a cheque can never produce a second Payment — not on retry, not on a race.
 * That key IS the ledger link; there is no parallel "cheque money" anywhere.
 *
 * A cheque whose amount exceeds what its installment still owes does not
 * overpay: the surplus stays unallocated on the Payment and is returned to the
 * caller, exactly as for a manual payment.
 *
 * A cheque with no commitment still becomes a Payment when it clears — money
 * left the business — just an unallocated one.
 *
 * # Bounce after clear
 *
 * The one way back from CLEARED. The Payment is VOIDED through the same status
 * flip `voidPayment` uses; its allocations stop counting through the active
 * predicate, and nothing is deleted.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
  assertPositiveAmount,
  fromMinorUnits,
  toMinorUnits,
} from "@/lib/services/payables/payables-core";
import {
  CHEQUE_CLEARED_SOURCE,
  assertChequeAdvance,
  assertChequeBounceable,
  assertChequeCancellable,
  assertChequeClearable,
  assertChequeReplaceable,
  assertCreatableStatus,
  availableChequeActions,
  chequePaymentKey,
  normalizeChequeNumber,
  type ChequeStatusValue,
} from "@/lib/services/payables/payables-cheque-core";
import { maskAccount } from "@/lib/services/payables/payables-bank-crypto";
import { isUniqueViolation } from "@/lib/services/payables/payables-bank-account.service";
import { recordPaymentInTx, writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

const REASON_MAX = 500;

/* ───────────────────────────────── view ───────────────────────────────── */

const CHEQUE_SELECT = {
  id: true,
  payeeId: true,
  payeeNameSnapshot: true,
  amount: true,
  currency: true,
  chequeNumber: true,
  issueDate: true,
  dueDate: true,
  status: true,
  sourceBankAccountId: true,
  installmentId: true,
  commitmentId: true,
  clearedAssertedAt: true,
  clearedSource: true,
  cancelledAt: true,
  cancellationReason: true,
  replacesChequeId: true,
  note: true,
  createdAt: true,
  // Masked projection of the source account — never its ciphertext.
  sourceBankAccount: { select: { id: true, label: true, accountLast4: true, isActive: true } },
  commitment: { select: { id: true, title: true } },
  installment: { select: { id: true, sequence: true, dueAt: true } },
  replacedBy: { select: { id: true, chequeNumber: true } },
  replaces: { select: { id: true, chequeNumber: true } },
} as const;

type ChequeRow = Prisma.ChequeGetPayload<{ select: typeof CHEQUE_SELECT }>;

export type ChequeView = {
  id: number;
  chequeNumber: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  amount: string;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  status: ChequeStatusValue;
  sourceBankAccount: { id: number; label: string; masked: string; isActive: boolean };
  commitment: { id: number; title: string } | null;
  installment: { id: number; sequence: number; dueAt: Date } | null;
  cleared: { assertedAt: Date | null; source: "OWNER_ASSERTED" } | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  replaces: { id: number; chequeNumber: string } | null;
  replacedBy: { id: number; chequeNumber: string } | null;
  payment: { id: number; status: string; allocated: string; unallocated: string } | null;
  note: string | null;
  createdAt: Date;
  actions: ReturnType<typeof availableChequeActions>;
};

function toView(
  row: ChequeRow,
  payment: ChequeView["payment"],
): ChequeView {
  const status = row.status as ChequeStatusValue;
  return {
    id: row.id,
    chequeNumber: row.chequeNumber,
    payeeId: row.payeeId,
    payeeNameSnapshot: row.payeeNameSnapshot,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    status,
    sourceBankAccount: {
      id: row.sourceBankAccount.id,
      label: row.sourceBankAccount.label,
      masked: maskAccount(row.sourceBankAccount.accountLast4),
      isActive: row.sourceBankAccount.isActive,
    },
    commitment: row.commitment,
    installment: row.installment,
    cleared:
      row.clearedSource === "OWNER_ASSERTED"
        ? { assertedAt: row.clearedAssertedAt, source: "OWNER_ASSERTED" }
        : null,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    replaces: row.replaces,
    // The partial unique index guarantees at most one successor.
    replacedBy: row.replacedBy[0] ?? null,
    payment,
    note: row.note,
    createdAt: row.createdAt,
    actions: availableChequeActions(status),
  };
}

/** The Payment a cleared cheque produced, with its split — or null. */
async function paymentsFor(
  tx: Tx,
  businessId: number,
  chequeIds: number[],
): Promise<Map<number, NonNullable<ChequeView["payment"]>>> {
  const out = new Map<number, NonNullable<ChequeView["payment"]>>();
  if (chequeIds.length === 0) return out;
  const payments = await tx.payment.findMany({
    where: { businessId, idempotencyKey: { in: chequeIds.map(chequePaymentKey) } },
    select: {
      id: true,
      status: true,
      amount: true,
      idempotencyKey: true,
      allocations: { where: { reversedAt: null }, select: { allocatedAmount: true } },
    },
  });
  for (const p of payments) {
    const chequeId = Number(p.idempotencyKey!.slice("cheque:".length));
    const amountMinor = toMinorUnits(p.amount.toFixed(2));
    const allocatedMinor =
      p.status === "RECORDED"
        ? p.allocations.reduce((sum, a) => sum + toMinorUnits(a.allocatedAmount.toFixed(2)), 0)
        : 0;
    out.set(chequeId, {
      id: p.id,
      status: p.status,
      allocated: fromMinorUnits(allocatedMinor),
      unallocated: fromMinorUnits(p.status === "RECORDED" ? amountMinor - allocatedMinor : 0),
    });
  }
  return out;
}

async function viewOf(tx: Tx, businessId: number, chequeId: number): Promise<ChequeView> {
  const row = await tx.cheque.findFirst({
    where: { id: chequeId, businessId },
    select: CHEQUE_SELECT,
  });
  if (!row) throw new PayablesNotFoundError("Cheque not found");
  const payments = await paymentsFor(tx, businessId, [row.id]);
  return toView(row, payments.get(row.id) ?? null);
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

function cleanReason(value: unknown, label = "reason"): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new PayablesValidationError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > REASON_MAX) {
    throw new PayablesValidationError(`${label} must be at most ${REASON_MAX} characters`);
  }
  return trimmed || null;
}

/** Lock the cheque row and return its lifecycle facts, tenant-scoped. */
async function lockCheque(tx: Tx, businessId: number, chequeId: number) {
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "Cheque"
    WHERE "id" = ${chequeId} AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  if (locked.length === 0) throw new PayablesNotFoundError("Cheque not found");
  const row = await tx.cheque.findFirst({
    where: { id: chequeId, businessId },
    select: {
      id: true,
      status: true,
      amount: true,
      currency: true,
      chequeNumber: true,
      payeeId: true,
      payeeNameSnapshot: true,
      commitmentId: true,
      installmentId: true,
      sourceBankAccountId: true,
      cancelledAt: true,
      issueDate: true,
    },
  });
  if (!row) throw new PayablesNotFoundError("Cheque not found");
  return { ...row, status: row.status as ChequeStatusValue };
}

async function assertActiveAccount(tx: Tx, businessId: number, bankAccountId: number) {
  const account = await tx.businessBankAccount.findFirst({
    where: { id: bankAccountId, businessId },
    select: { id: true, isActive: true },
  });
  if (!account) throw new PayablesNotFoundError("Bank account not found");
  if (!account.isActive) {
    throw new PayablesValidationError("A cheque cannot be drawn on an archived bank account");
  }
}

/**
 * Resolve what the cheque is FOR. An installment implies its commitment; a
 * commitment given alongside must agree. Both are tenant-scoped reads, so a
 * foreign id is simply "not found".
 */
async function resolveTarget(
  tx: Tx,
  businessId: number,
  input: { commitmentId: number | null; installmentId: number | null },
): Promise<{
  commitmentId: number | null;
  installmentId: number | null;
  payeeId: number | null;
  payeeNameSnapshot: string | null;
  currency: string | null;
}> {
  let commitmentId = input.commitmentId;
  if (input.installmentId) {
    const inst = await tx.installment.findFirst({
      where: { id: input.installmentId, businessId },
      select: { id: true, commitmentId: true, status: true },
    });
    if (!inst) throw new PayablesNotFoundError("Installment not found");
    if (commitmentId && commitmentId !== inst.commitmentId) {
      throw new PayablesValidationError("The installment does not belong to that commitment");
    }
    if (inst.status !== "SCHEDULED") {
      throw new PayablesValidationError(`A ${inst.status} installment cannot take a cheque`);
    }
    commitmentId = inst.commitmentId;
  }
  if (!commitmentId) {
    return { commitmentId: null, installmentId: null, payeeId: null, payeeNameSnapshot: null, currency: null };
  }
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, businessId },
    select: { id: true, status: true, payeeId: true, payeeNameSnapshot: true, currency: true },
  });
  if (!commitment) throw new PayablesNotFoundError("Commitment not found");
  if (commitment.status !== "ACTIVE") {
    throw new PayablesValidationError(`A ${commitment.status} commitment cannot take a cheque`);
  }
  return {
    commitmentId: commitment.id,
    installmentId: input.installmentId,
    payeeId: commitment.payeeId,
    payeeNameSnapshot: commitment.payeeNameSnapshot,
    currency: commitment.currency,
  };
}

function duplicateNumber(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new PayablesConflictError(
      "A live cheque with this number already exists in this chequebook",
    );
  }
  throw error;
}

/* ──────────────────────────────── reads ───────────────────────────────── */

export async function listCheques(input: {
  businessId: number;
  commitmentId?: number | null;
  scope?: "open" | "all";
}): Promise<ChequeView[]> {
  return withTenantTransaction(async (tx) => {
    const rows = await tx.cheque.findMany({
      where: {
        businessId: input.businessId,
        ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
        ...(input.scope === "all"
          ? {}
          : { status: { in: ["PLANNED", "ISSUED", "DELIVERED", "PRESENTED", "BOUNCED"] as never } }),
      },
      select: CHEQUE_SELECT,
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: 500,
    });
    const payments = await paymentsFor(
      tx,
      input.businessId,
      rows.filter((r) => r.status === "CLEARED" || r.status === "BOUNCED").map((r) => r.id),
    );
    return rows.map((r) => toView(r, payments.get(r.id) ?? null));
  });
}

export async function getCheque(input: { businessId: number; chequeId: number }) {
  return withTenantTransaction((tx) => viewOf(tx, input.businessId, input.chequeId));
}

/* ─────────────────────────────── create ──────────────────────────────── */

export type CreateChequeInput = {
  businessId: number;
  actorUserId?: number | null;
  chequeNumber: unknown;
  amount: string;
  issueDate: Date;
  dueDate: Date;
  sourceBankAccountId: number;
  commitmentId?: number | null;
  installmentId?: number | null;
  payeeId?: number | null;
  payeeName?: string | null;
  status?: ChequeStatusValue;
  note?: unknown;
};

async function createChequeInTx(
  tx: Tx,
  input: CreateChequeInput & { replacesChequeId?: number | null },
): Promise<number> {
  const chequeNumber = normalizeChequeNumber(input.chequeNumber);
  const amountMinor = toMinorUnits(input.amount);
  assertPositiveAmount(amountMinor, "cheque amount");
  const status = input.status ?? "PLANNED";
  assertCreatableStatus(status);
  if (input.dueDate.getTime() < input.issueDate.getTime()) {
    throw new PayablesValidationError("A cheque cannot be due before it is written");
  }
  const note = cleanReason(input.note, "note");

  await assertActiveAccount(tx, input.businessId, input.sourceBankAccountId);
  const target = await resolveTarget(tx, input.businessId, {
    commitmentId: input.commitmentId ?? null,
    installmentId: input.installmentId ?? null,
  });

  // Who the cheque is made out to. A commitment's payee wins — the cheque pays
  // that commitment. Otherwise a known Payee, otherwise the name as written.
  let payeeId = target.payeeId;
  let payeeNameSnapshot = target.payeeNameSnapshot;
  if (!target.commitmentId) {
    if (input.payeeId) {
      const payee = await tx.payee.findFirst({
        where: { id: input.payeeId, businessId: input.businessId },
        select: { id: true, displayName: true },
      });
      if (!payee) throw new PayablesNotFoundError("Payee not found");
      payeeId = payee.id;
      payeeNameSnapshot = payee.displayName;
    } else {
      payeeNameSnapshot = input.payeeName?.trim() || null;
    }
  }
  if (!payeeNameSnapshot) {
    throw new PayablesValidationError("A cheque needs a payee: a commitment, a payee, or a name");
  }

  const currency = target.currency ?? "ILS";
  const row = await tx.cheque.create({
    data: {
      businessId: input.businessId,
      payeeId,
      payeeNameSnapshot,
      amount: new Prisma.Decimal(fromMinorUnits(amountMinor)),
      currency,
      chequeNumber,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      sourceBankAccountId: input.sourceBankAccountId,
      commitmentId: target.commitmentId,
      installmentId: target.installmentId,
      status: status as never,
      replacesChequeId: input.replacesChequeId ?? null,
      note,
      createdByUserId: input.actorUserId ?? null,
    },
    select: { id: true },
  });

  await writeAudit(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    commitmentId: target.commitmentId,
    installmentId: target.installmentId,
    eventType: "CHEQUE_CREATED",
    summary: `Cheque #${chequeNumber} for ${fromMinorUnits(amountMinor)} ${currency} recorded as ${status}`,
    metadata: {
      chequeId: row.id,
      chequeNumber,
      amount: fromMinorUnits(amountMinor),
      status,
      sourceBankAccountId: input.sourceBankAccountId,
      replacesChequeId: input.replacesChequeId ?? null,
    },
  });
  return row.id;
}

export async function createCheque(input: CreateChequeInput): Promise<ChequeView> {
  try {
    return await withTenantTransaction(async (tx) => {
      const id = await createChequeInTx(tx, input);
      return viewOf(tx, input.businessId, id);
    });
  } catch (error) {
    duplicateNumber(error);
  }
}

/* ─────────────────────────────── advance ─────────────────────────────── */

export async function advanceCheque(input: {
  businessId: number;
  actorUserId?: number | null;
  chequeId: number;
  to: ChequeStatusValue;
}): Promise<ChequeView> {
  return withTenantTransaction(async (tx) => {
    const cheque = await lockCheque(tx, input.businessId, input.chequeId);
    if (cheque.status === input.to) return viewOf(tx, input.businessId, cheque.id); // idempotent
    assertChequeAdvance(cheque.status, input.to);
    await tx.cheque.update({ where: { id: cheque.id }, data: { status: input.to as never } });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: cheque.commitmentId,
      installmentId: cheque.installmentId,
      eventType: "CHEQUE_ADVANCED",
      summary: `Cheque #${cheque.chequeNumber}: ${cheque.status} → ${input.to}`,
      metadata: { chequeId: cheque.id, from: cheque.status, to: input.to },
    });
    return viewOf(tx, input.businessId, cheque.id);
  });
}

/* ──────────────────────────────── clear ──────────────────────────────── */

/**
 * The owner says this cheque cleared. Status, provenance and the canonical
 * Payment land together or not at all.
 */
export async function clearCheque(input: {
  businessId: number;
  actorUserId?: number | null;
  chequeId: number;
  clearedAt: Date;
}): Promise<{ cheque: ChequeView; unallocated: string; replayed: boolean }> {
  return withTenantTransaction(async (tx) => {
    const cheque = await lockCheque(tx, input.businessId, input.chequeId);
    const key = chequePaymentKey(cheque.id);

    if (cheque.status === "CLEARED") {
      // Idempotent: the Payment already exists under the cheque's key.
      const view = await viewOf(tx, input.businessId, cheque.id);
      return { cheque: view, unallocated: view.payment?.unallocated ?? "0.00", replayed: true };
    }
    assertChequeClearable(cheque.status);
    if (input.clearedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new PayablesValidationError("A cheque cannot have cleared in the future");
    }
    // Day granularity: the form sends noon of the chosen day, so a same-day
    // clearing must not be refused over the hour it was written.
    if (input.clearedAt.toISOString().slice(0, 10) < cheque.issueDate.toISOString().slice(0, 10)) {
      throw new PayablesValidationError("A cheque cannot have cleared before it was written");
    }

    // A Payment under this key without a CLEARED cheque would mean a second
    // economic event is about to be created for one cheque. Refuse loudly.
    const prior = await tx.payment.findFirst({
      where: { businessId: input.businessId, idempotencyKey: key },
      select: { id: true },
    });
    if (prior) {
      throw new PayablesConflictError("This cheque already produced a payment");
    }

    await tx.cheque.update({
      where: { id: cheque.id },
      data: {
        status: "CLEARED" as never,
        clearedAssertedAt: input.clearedAt,
        clearedSource: CHEQUE_CLEARED_SOURCE as never,
        clearedAssertedBy: input.actorUserId ?? null,
      },
    });

    const amount = cheque.amount.toFixed(2);
    const evidenceNote = `Cheque #${cheque.chequeNumber} — cleared, owner-asserted (not bank-verified)`;
    let paymentId: number;
    let unallocated: string;

    // A commitment closed or released since the cheque was written can no
    // longer receive allocations — but the money still left. It then becomes
    // an unallocated Payment rather than a refused clearing.
    const commitmentOpen = cheque.commitmentId
      ? (
          await tx.commitment.findFirst({
            where: { id: cheque.commitmentId, businessId: input.businessId },
            select: { status: true },
          })
        )?.status === "ACTIVE"
      : false;

    if (cheque.commitmentId && commitmentOpen) {
      const result = await recordPaymentInTx(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: cheque.commitmentId,
        amount,
        paidAt: input.clearedAt,
        method: "CHECK",
        externalReference: cheque.chequeNumber,
        idempotencyKey: key,
        installmentIds: cheque.installmentId ? [cheque.installmentId] : null,
        evidence: { kind: "CHEQUE", note: evidenceNote },
        auditSummary: `Cheque #${cheque.chequeNumber} of ${amount} ${cheque.currency} cleared (owner-asserted)`,
      });
      paymentId = result.payment.id;
      unallocated = result.unallocated ?? "0.00";
    } else {
      // No commitment: money still left the business, so it is still a
      // Payment — one with nothing to settle.
      const payment = await tx.payment.create({
        data: {
          businessId: input.businessId,
          payeeId: cheque.payeeId,
          payeeNameSnapshot: cheque.payeeNameSnapshot,
          amount: new Prisma.Decimal(amount),
          currency: cheque.currency,
          paidAt: input.clearedAt,
          method: "CHECK" as never,
          externalReference: cheque.chequeNumber,
          idempotencyKey: key,
          createdByUserId: input.actorUserId ?? null,
        },
        select: { id: true },
      });
      await tx.paymentEvidence.create({
        data: {
          businessId: input.businessId,
          paymentId: payment.id,
          kind: "CHEQUE" as never,
          note: evidenceNote,
          assertedByUserId: input.actorUserId ?? null,
        },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: payment.id,
        eventType: "PAYMENT_RECORDED",
        summary: `Cheque #${cheque.chequeNumber} of ${amount} ${cheque.currency} cleared (owner-asserted)`,
        metadata: { amount, unallocated: amount, method: "CHECK" },
      });
      paymentId = payment.id;
      unallocated = amount;
    }

    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: cheque.commitmentId,
      installmentId: cheque.installmentId,
      paymentId,
      eventType: "CHEQUE_CLEARED_OWNER_ASSERTED",
      summary: `Cheque #${cheque.chequeNumber} marked cleared by the owner`,
      metadata: {
        chequeId: cheque.id,
        from: cheque.status,
        clearedSource: CHEQUE_CLEARED_SOURCE,
        clearedAt: input.clearedAt.toISOString(),
        unallocated,
      },
    });

    return { cheque: await viewOf(tx, input.businessId, cheque.id), unallocated, replayed: false };
  });
}

/* ──────────────────────────────── bounce ─────────────────────────────── */

export async function bounceCheque(input: {
  businessId: number;
  actorUserId?: number | null;
  chequeId: number;
  reason?: unknown;
}): Promise<ChequeView> {
  const reason = cleanReason(input.reason);
  return withTenantTransaction(async (tx) => {
    const cheque = await lockCheque(tx, input.businessId, input.chequeId);
    if (cheque.status === "BOUNCED") return viewOf(tx, input.businessId, cheque.id); // idempotent
    assertChequeBounceable(cheque.status);

    let voidedPaymentId: number | null = null;
    if (cheque.status === "CLEARED") {
      const payment = await tx.payment.findFirst({
        where: { businessId: input.businessId, idempotencyKey: chequePaymentKey(cheque.id) },
        select: { id: true, status: true },
      });
      if (payment && payment.status === "RECORDED") {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "VOID" as never,
            voidedAt: new Date(),
            voidedByUserId: input.actorUserId ?? null,
            voidReason: `Cheque #${cheque.chequeNumber} bounced${reason ? `: ${reason}` : ""}`,
          },
        });
        await writeAudit(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId,
          paymentId: payment.id,
          eventType: "PAYMENT_VOIDED",
          summary: `Payment voided — cheque #${cheque.chequeNumber} bounced`,
          metadata: { chequeId: cheque.id, reason },
        });
        voidedPaymentId = payment.id;
      }
    }

    await tx.cheque.update({ where: { id: cheque.id }, data: { status: "BOUNCED" as never } });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: cheque.commitmentId,
      installmentId: cheque.installmentId,
      paymentId: voidedPaymentId,
      eventType: "CHEQUE_BOUNCED",
      summary: `Cheque #${cheque.chequeNumber} bounced`,
      metadata: { chequeId: cheque.id, from: cheque.status, reason, voidedPaymentId },
    });
    return viewOf(tx, input.businessId, cheque.id);
  });
}

/* ──────────────────────────────── cancel ─────────────────────────────── */

export async function cancelCheque(input: {
  businessId: number;
  actorUserId?: number | null;
  chequeId: number;
  reason?: unknown;
}): Promise<ChequeView> {
  const reason = cleanReason(input.reason);
  return withTenantTransaction(async (tx) => {
    const cheque = await lockCheque(tx, input.businessId, input.chequeId);
    if (cheque.status === "CANCELLED") return viewOf(tx, input.businessId, cheque.id); // idempotent
    assertChequeCancellable(cheque.status);
    // `cancelledAt` is what releases the number: the migration's partial index
    // only guards rows where it is NULL.
    await tx.cheque.update({
      where: { id: cheque.id },
      data: { status: "CANCELLED" as never, cancelledAt: new Date(), cancellationReason: reason },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: cheque.commitmentId,
      installmentId: cheque.installmentId,
      eventType: "CHEQUE_CANCELLED",
      summary: `Cheque #${cheque.chequeNumber} cancelled`,
      metadata: { chequeId: cheque.id, from: cheque.status, reason },
    });
    return viewOf(tx, input.businessId, cheque.id);
  });
}

/* ──────────────────────────────── replace ────────────────────────────── */

/**
 * Replace a cheque with a new one. The old row is NOT edited into the new one:
 * it becomes REPLACED (releasing its number), and a NEW row links back to it
 * through `replacesChequeId`. The chain cannot fork — the migration's partial
 * unique index refuses a second successor even if this check were bypassed.
 *
 * The replacement inherits what the cheque was FOR (commitment, installment,
 * payee) unless the owner says otherwise; number, dates and account are new.
 */
export async function replaceCheque(input: {
  businessId: number;
  actorUserId?: number | null;
  chequeId: number;
  chequeNumber: unknown;
  amount?: string | null;
  issueDate: Date;
  dueDate: Date;
  sourceBankAccountId?: number | null;
  status?: ChequeStatusValue;
  reason?: unknown;
  note?: unknown;
}): Promise<{ replaced: ChequeView; replacement: ChequeView }> {
  const reason = cleanReason(input.reason);
  try {
    return await withTenantTransaction(async (tx) => {
      const old = await lockCheque(tx, input.businessId, input.chequeId);
      assertChequeReplaceable(old.status);

      const successor = await tx.cheque.findFirst({
        where: { businessId: input.businessId, replacesChequeId: old.id },
        select: { id: true },
      });
      if (successor) throw new PayablesConflictError("This cheque has already been replaced");

      // Release the old number FIRST, so the replacement may legitimately reuse
      // it (a bank can reissue a number) without tripping the live-number index.
      await tx.cheque.update({
        where: { id: old.id },
        data: {
          status: "REPLACED" as never,
          cancelledAt: old.cancelledAt ?? new Date(),
          cancellationReason: reason ?? undefined,
        },
      });

      const replacementId = await createChequeInTx(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        chequeNumber: input.chequeNumber,
        amount: input.amount ?? old.amount.toFixed(2),
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        sourceBankAccountId: input.sourceBankAccountId ?? old.sourceBankAccountId,
        commitmentId: old.commitmentId,
        installmentId: old.installmentId,
        payeeId: old.commitmentId ? null : old.payeeId,
        payeeName: old.commitmentId ? null : old.payeeNameSnapshot,
        status: input.status ?? "PLANNED",
        note: input.note,
        replacesChequeId: old.id,
      });

      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: old.commitmentId,
        installmentId: old.installmentId,
        eventType: "CHEQUE_REPLACED",
        summary: `Cheque #${old.chequeNumber} replaced`,
        metadata: { chequeId: old.id, from: old.status, replacementChequeId: replacementId, reason },
      });

      return {
        replaced: await viewOf(tx, input.businessId, old.id),
        replacement: await viewOf(tx, input.businessId, replacementId),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Either the new number collides with a live cheque, or a concurrent
      // replacement won the race for the same predecessor.
      throw new PayablesConflictError(
        "The replacement was refused: its number is already live in that chequebook, or the cheque was already replaced",
      );
    }
    throw error;
  }
}
