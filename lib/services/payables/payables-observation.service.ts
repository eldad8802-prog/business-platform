/**
 * Bank / external observation and reconciliation — Accounts Payable Phase 5.
 *
 * An ExternalTransaction is what a bank or provider REPORTED. It is never a
 * Payment and never moves a balance by itself. Reconciliation decides, with the
 * owner, which existing economic event it evidences.
 *
 * # Where lines come from — the adapter boundary
 *
 * No bank feed is connected to Dubiz today, and none is simulated. Two real,
 * owner-driven channels exist:
 *
 *   OWNER_ENTRY   the owner types a line they see in their bank app
 *   OWNER_UPLOAD  the owner uploads the CSV their bank exports
 *
 * A future feed or provider is a new `ExternalTransactionSource` value
 * (BANK_FEED / PROVIDER already exist in the enum) calling `ingestObservations`
 * with its own stable externalId. Nothing downstream changes.
 *
 * # The rules, same as Phase 2 (documents), because they are the same problem
 *
 *   - ingestion is idempotent: (business, source, externalId) is unique, and a
 *     re-delivered or re-uploaded line is the same row
 *   - the observed facts are immutable (trigger); only a dismissal is recorded
 *   - suggestions are DERIVED at read time and never stored; the owner's
 *     decisions (attach, record, reject, dismiss) are
 *   - amount alone never establishes identity (`scoreBankLine` → Phase 2 rules)
 *   - ties are reported as ambiguous, never silently resolved
 *   - an existing Payment + a later bank line → EVIDENCE on that Payment, never
 *     a second Payment (the DB refuses one line evidencing two Payments)
 *   - a new Payment from a bank line is an explicit owner decision, and is
 *     refused while a similar Payment already exists unless the owner says the
 *     similar one is a different event
 *   - revoking evidence never moves money
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
  deriveInstallmentBalance,
  fromMinorUnits,
  toMinorUnits,
} from "@/lib/services/payables/payables-core";
import { confidenceOf, rankCandidates, type Confidence } from "@/lib/services/payables/payables-matching";
import {
  parseStatementCsv,
  scoreBankLine,
  statementLineIdentities,
  type BankCandidate,
  type BankCandidateTarget,
  type StatementLine,
} from "@/lib/services/payables/payables-p46-core";
import { isUniqueViolation } from "@/lib/services/payables/payables-bank-account.service";
import { completePreparationInTx } from "@/lib/services/payables/payables-preparation.service";
import { recordPaymentInTx, toFacts, writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

export const MAX_UPLOAD_BYTES = 1_000_000;
export const MAX_UPLOAD_LINES = 5_000;
const SUGGESTION_WINDOW_DAYS = 60;

export function observationPaymentKey(externalTransactionId: number): string {
  return `ext:${externalTransactionId}`;
}

/* ──────────────────────────────── ingest ──────────────────────────────── */

export type IngestLine = StatementLine & { externalId: string };

/**
 * Insert observations idempotently. Returns how many were NEW and how many were
 * already known — a re-upload of the same statement reports zero new.
 */
export async function ingestObservations(input: {
  businessId: number;
  actorUserId?: number | null;
  source: "OWNER_ENTRY" | "OWNER_UPLOAD" | "BANK_FEED" | "PROVIDER";
  sourceBankAccountId?: number | null;
  importBatchId?: string | null;
  lines: IngestLine[];
}): Promise<{ inserted: number; alreadyKnown: number }> {
  if (input.lines.length === 0) return { inserted: 0, alreadyKnown: 0 };
  return withTenantTransaction(async (tx) => {
    if (input.sourceBankAccountId) {
      const account = await tx.businessBankAccount.findFirst({
        where: { id: input.sourceBankAccountId, businessId: input.businessId },
        select: { id: true },
      });
      if (!account) throw new PayablesNotFoundError("Bank account not found");
    }
    const result = await tx.externalTransaction.createMany({
      data: input.lines.map((l) => ({
        businessId: input.businessId,
        source: input.source as never,
        externalId: l.externalId,
        sourceBankAccountId: input.sourceBankAccountId ?? null,
        direction: l.direction as never,
        amount: new Prisma.Decimal(fromMinorUnits(l.amountMinor)),
        bookedAt: l.bookedAt,
        counterpartyName: l.counterpartyName,
        reference: l.reference,
        description: l.description,
        importBatchId: input.importBatchId ?? null,
        createdByUserId: input.actorUserId ?? null,
      })),
      // ON CONFLICT DO NOTHING against (business, source, externalId).
      skipDuplicates: true,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "EXTERNAL_TRANSACTIONS_INGESTED",
      summary: `${result.count} new bank line(s) recorded from ${input.source}`,
      metadata: {
        source: input.source,
        importBatchId: input.importBatchId ?? null,
        offered: input.lines.length,
        inserted: result.count,
      },
    });
    return { inserted: result.count, alreadyKnown: input.lines.length - result.count };
  });
}

/** The owner types one line from their bank app. `clientKey` makes a double submit one line. */
export async function recordObservationManually(input: {
  businessId: number;
  actorUserId?: number | null;
  clientKey: string;
  sourceBankAccountId?: number | null;
  bookedAt: Date;
  amount: string;
  direction: "DEBIT" | "CREDIT";
  counterpartyName?: string | null;
  reference?: string | null;
  description?: string | null;
}) {
  const key = input.clientKey.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new PayablesValidationError("clientKey is invalid");
  const amountMinor = toMinorUnits(input.amount);
  if (amountMinor <= 0) throw new PayablesValidationError("amount must be positive");
  const clip = (v: string | null | undefined) => (v && v.trim() ? v.trim().slice(0, 300) : null);
  return ingestObservations({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    source: "OWNER_ENTRY",
    sourceBankAccountId: input.sourceBankAccountId ?? null,
    lines: [
      {
        lineNumber: 1,
        externalId: `own:${key}`,
        bookedAt: input.bookedAt,
        amountMinor,
        direction: input.direction,
        counterpartyName: clip(input.counterpartyName),
        reference: clip(input.reference),
        description: clip(input.description),
      },
    ],
  });
}

/** The owner uploads their bank's CSV export. */
export async function uploadStatement(input: {
  businessId: number;
  actorUserId?: number | null;
  sourceBankAccountId?: number | null;
  csvText: string;
}) {
  if (Buffer.byteLength(input.csvText, "utf8") > MAX_UPLOAD_BYTES) {
    throw new PayablesValidationError("The file is larger than 1 MB");
  }
  const parsed = parseStatementCsv(input.csvText);
  if (parsed.lines.length > MAX_UPLOAD_LINES) {
    throw new PayablesValidationError(`At most ${MAX_UPLOAD_LINES} lines per upload`);
  }
  const ids = statementLineIdentities(input.businessId, input.sourceBankAccountId ?? null, parsed.lines);
  const importBatchId = `upl-${Date.now().toString(36)}`;
  const { inserted, alreadyKnown } = await ingestObservations({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    source: "OWNER_UPLOAD",
    sourceBankAccountId: input.sourceBankAccountId ?? null,
    importBatchId,
    lines: parsed.lines.map((l, i) => ({ ...l, externalId: ids[i] })),
  });
  return { inserted, alreadyKnown, errors: parsed.errors, parsed: parsed.lines.length };
}

/* ──────────────────────────────── reads ───────────────────────────────── */

const OBS_SELECT = {
  id: true,
  source: true,
  direction: true,
  amount: true,
  currency: true,
  bookedAt: true,
  counterpartyName: true,
  reference: true,
  description: true,
  dismissedAt: true,
  dismissReason: true,
  createdAt: true,
  sourceBankAccount: { select: { id: true, label: true, accountLast4: true } },
  evidences: {
    where: { revokedAt: null },
    select: { id: true, paymentId: true, payment: { select: { id: true, status: true, payeeNameSnapshot: true } } },
  },
} as const;

type ObsRow = Prisma.ExternalTransactionGetPayload<{ select: typeof OBS_SELECT }>;

export type ObservationView = {
  id: number;
  source: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  currency: string;
  bookedAt: Date;
  counterpartyName: string | null;
  reference: string | null;
  description: string | null;
  sourceAccount: { id: number; label: string; last4: string } | null;
  /** Derived, never stored. */
  state: "MATCHED" | "OPEN" | "DISMISSED" | "NOT_A_PAYABLE";
  matchedPayment: { evidenceId: number; paymentId: number; payeeName: string; paymentStatus: string } | null;
  dismissReason: string | null;
};

function toObsView(row: ObsRow): ObservationView {
  const ev = row.evidences[0] ?? null;
  const state: ObservationView["state"] = ev
    ? "MATCHED"
    : row.dismissedAt
      ? "DISMISSED"
      : row.direction === "CREDIT"
        ? "NOT_A_PAYABLE"
        : "OPEN";
  return {
    id: row.id,
    source: row.source,
    direction: row.direction as "DEBIT" | "CREDIT",
    amount: row.amount.toFixed(2),
    currency: row.currency,
    bookedAt: row.bookedAt,
    counterpartyName: row.counterpartyName,
    reference: row.reference,
    description: row.description,
    sourceAccount: row.sourceBankAccount
      ? { id: row.sourceBankAccount.id, label: row.sourceBankAccount.label, last4: row.sourceBankAccount.accountLast4 }
      : null,
    state,
    matchedPayment: ev
      ? { evidenceId: ev.id, paymentId: ev.paymentId, payeeName: ev.payment.payeeNameSnapshot, paymentStatus: ev.payment.status }
      : null,
    dismissReason: row.dismissReason,
  };
}

export async function listObservations(input: { businessId: number; scope?: "open" | "all" }) {
  return withTenantTransaction(async (tx) => {
    const rows = await tx.externalTransaction.findMany({
      where: {
        businessId: input.businessId,
        ...(input.scope === "all"
          ? {}
          : { dismissedAt: null, direction: "DEBIT" as never, evidences: { none: { revokedAt: null } } }),
      },
      select: OBS_SELECT,
      orderBy: [{ bookedAt: "desc" }, { id: "desc" }],
      take: 500,
    });
    return rows.map(toObsView);
  });
}

async function loadObservation(tx: Tx, businessId: number, id: number) {
  const row = await tx.externalTransaction.findFirst({ where: { id, businessId } });
  if (!row) throw new PayablesNotFoundError("Bank line not found");
  return row;
}

/* ─────────────────────────────── suggest ──────────────────────────────── */

export type ObservationSuggestion = {
  kind: "PAYMENT" | "INSTALLMENT" | "PREPARATION";
  id: number;
  commitmentId: number;
  commitmentTitle: string;
  payeeName: string;
  amount: string;
  date: Date;
  confidence: Confidence;
  reasons: string[];
  /** INSTALLMENT only: the installment id to record against. */
  installmentId?: number;
};

/**
 * Derived candidates for one bank line. Nothing is stored. Three kinds:
 *   PAYMENT      an existing Payment this line may EVIDENCE (no new money)
 *   PREPARATION  an approved prepared payment this line may COMPLETE
 *   INSTALLMENT  an open installment a NEW Payment may be recorded against
 */
export async function suggestForObservation(input: { businessId: number; externalTransactionId: number }) {
  return withTenantTransaction(async (tx) => {
    const line = await loadObservation(tx, input.businessId, input.externalTransactionId);
    if (line.direction !== "DEBIT") {
      return { suggestions: [] as ObservationSuggestion[], ambiguous: false, reason: "NOT_A_PAYABLE" as const };
    }
    const amountMinor = toMinorUnits(line.amount.toFixed(2));
    const from = new Date(line.bookedAt.getTime() - SUGGESTION_WINDOW_DAYS * 86_400_000);
    const to = new Date(line.bookedAt.getTime() + SUGGESTION_WINDOW_DAYS * 86_400_000);
    const rejections = await tx.externalTransactionMatchRejection.findMany({
      where: { businessId: input.businessId, externalTransactionId: line.id },
      select: { paymentId: true, installmentId: true },
    });
    const rejectedPayments = new Set(rejections.map((r) => r.paymentId).filter(Boolean));
    const rejectedInstallments = new Set(rejections.map((r) => r.installmentId).filter(Boolean));

    const facts = {
      externalTransactionId: line.id,
      amountMinor,
      bookedAt: line.bookedAt,
      direction: "DEBIT" as const,
      counterpartyName: line.counterpartyName,
      description: line.description,
      reference: line.reference,
    };

    const candidates: Array<{ c: BankCandidate; kind: ObservationSuggestion["kind"]; extra: Partial<ObservationSuggestion> }> = [];

    // Existing Payments of the same amount, not already evidenced by a bank line.
    const payments = await tx.payment.findMany({
      where: {
        businessId: input.businessId,
        status: "RECORDED" as never,
        amount: new Prisma.Decimal(fromMinorUnits(amountMinor)),
        paidAt: { gte: from, lte: to },
        evidences: { none: { revokedAt: null, externalTransactionId: { not: null } } },
      },
      select: {
        id: true,
        amount: true,
        paidAt: true,
        payeeId: true,
        payeeNameSnapshot: true,
        externalReference: true,
        allocations: { where: { reversedAt: null }, take: 1, select: { installment: { select: { commitmentId: true, commitment: { select: { title: true } } } } } },
        evidences: { where: { revokedAt: null, documentId: { not: null } }, take: 1, select: { id: true } },
      },
      take: 100,
    });
    for (const p of payments) {
      if (rejectedPayments.has(p.id)) continue;
      const alloc = p.allocations[0]?.installment;
      const target: BankCandidateTarget = {
        kind: "PAYMENT",
        paymentId: p.id,
        commitmentId: alloc?.commitmentId ?? 0,
        commitmentTitle: alloc?.commitment.title ?? "",
        payeeNameSnapshot: p.payeeNameSnapshot,
        payeeId: p.payeeId,
        amountMinor: toMinorUnits(p.amount.toFixed(2)),
        paidAt: p.paidAt,
        hasDocumentEvidence: false,
        externalReference: p.externalReference,
      };
      const c = scoreBankLine(facts, target);
      if (c) candidates.push({ c, kind: "PAYMENT", extra: {} });
    }

    // Approved preparations of the same amount: this line may be the transfer.
    const preps = await tx.paymentPreparation.findMany({
      where: {
        businessId: input.businessId,
        status: { in: ["APPROVED", "FAILED"] as never },
        amount: new Prisma.Decimal(fromMinorUnits(amountMinor)),
      },
      select: {
        id: true,
        amount: true,
        approvedAt: true,
        payeeId: true,
        payeeNameSnapshot: true,
        reference: true,
        commitmentId: true,
        commitment: { select: { title: true } },
      },
      take: 50,
    });
    for (const p of preps) {
      const target: BankCandidateTarget = {
        kind: "INSTALLMENT",
        installmentId: p.id,
        commitmentId: p.commitmentId,
        commitmentTitle: p.commitment.title,
        payeeNameSnapshot: p.payeeNameSnapshot,
        payeeId: p.payeeId,
        remainingMinor: toMinorUnits(p.amount.toFixed(2)),
        dueAt: p.approvedAt ?? line.bookedAt,
      };
      const c = scoreBankLine(facts, target);
      if (c) candidates.push({ c, kind: "PREPARATION", extra: {} });
    }

    // Open installments that still owe exactly this amount: a NEW Payment.
    const installments = await tx.installment.findMany({
      where: {
        businessId: input.businessId,
        status: "SCHEDULED" as never,
        dueAt: { gte: from, lte: to },
        commitment: { status: "ACTIVE" as never },
      },
      include: {
        allocations: { include: { payment: { select: { status: true } } } },
        commitment: { select: { id: true, title: true, payeeId: true, payeeNameSnapshot: true } },
      },
      take: 300,
    });
    for (const inst of installments) {
      if (rejectedInstallments.has(inst.id)) continue;
      const remaining = deriveInstallmentBalance(toFacts(inst), new Date()).remainingMinor;
      if (remaining <= 0) continue;
      const target: BankCandidateTarget = {
        kind: "INSTALLMENT",
        installmentId: inst.id,
        commitmentId: inst.commitment.id,
        commitmentTitle: inst.commitment.title,
        payeeNameSnapshot: inst.commitment.payeeNameSnapshot,
        payeeId: inst.commitment.payeeId,
        remainingMinor: remaining,
        dueAt: inst.dueAt,
      };
      const c = scoreBankLine(facts, target);
      if (c) candidates.push({ c, kind: "INSTALLMENT", extra: { installmentId: inst.id } });
    }

    const { ranked, ambiguous } = rankCandidates(candidates.map((x) => x.c));
    const byCandidate = new Map(candidates.map((x) => [x.c, x]));
    const suggestions: ObservationSuggestion[] = ranked.map((c) => {
      const meta = byCandidate.get(c as BankCandidate)!;
      const t = c.target;
      const isPayment = t.kind === "PAYMENT";
      return {
        kind: meta.kind,
        id: isPayment ? t.paymentId : t.installmentId,
        commitmentId: t.commitmentId,
        commitmentTitle: t.commitmentTitle,
        payeeName: t.payeeNameSnapshot,
        amount: fromMinorUnits(isPayment ? t.amountMinor : t.remainingMinor),
        date: isPayment ? t.paidAt : t.dueAt,
        confidence: confidenceOf(c),
        reasons: c.reasons,
        ...meta.extra,
      };
    });
    return { suggestions, ambiguous, reason: null };
  });
}

/* ─────────────────────────────── decide ───────────────────────────────── */

async function assertLineOpen(tx: Tx, businessId: number, id: number) {
  await tx.$queryRaw`SELECT "id" FROM "ExternalTransaction" WHERE "id" = ${id} AND "businessId" = ${businessId} FOR UPDATE`;
  const line = await loadObservation(tx, businessId, id);
  if (line.direction !== "DEBIT") throw new PayablesValidationError("An incoming credit is not a payable");
  if (line.dismissedAt) throw new PayablesValidationError("This bank line was dismissed");
  const active = await tx.paymentEvidence.findFirst({
    where: { businessId, externalTransactionId: id, revokedAt: null },
    select: { id: true },
  });
  if (active) throw new PayablesConflictError("This bank line already evidences a payment");
  return line;
}

/**
 * The line is evidence of a Payment that ALREADY exists (a manual payment, a
 * cleared cheque, a completed preparation). No money moves; no second Payment.
 */
export async function attachObservationToPayment(input: {
  businessId: number;
  actorUserId?: number | null;
  externalTransactionId: number;
  paymentId: number;
}) {
  try {
    return await withTenantTransaction(async (tx) => {
      const line = await assertLineOpen(tx, input.businessId, input.externalTransactionId);
      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, businessId: input.businessId },
        select: { id: true, status: true, amount: true },
      });
      if (!payment) throw new PayablesNotFoundError("Payment not found");
      if (payment.status !== "RECORDED") throw new PayablesValidationError("A voided payment cannot be evidenced");
      if (toMinorUnits(payment.amount.toFixed(2)) !== toMinorUnits(line.amount.toFixed(2))) {
        throw new PayablesValidationError("The bank line amount differs from the payment");
      }
      const already = await tx.paymentEvidence.findFirst({
        where: { businessId: input.businessId, paymentId: payment.id, revokedAt: null, externalTransactionId: { not: null } },
        select: { id: true },
      });
      if (already) throw new PayablesConflictError("This payment is already evidenced by another bank line");
      const ev = await tx.paymentEvidence.create({
        data: {
          businessId: input.businessId,
          paymentId: payment.id,
          kind: "BANK_TRANSACTION" as never,
          externalTransactionId: line.id,
          note: "Bank line attached by the owner as evidence of this payment",
          assertedByUserId: input.actorUserId ?? null,
        },
        select: { id: true },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: payment.id,
        eventType: "EXTERNAL_TRANSACTION_ATTACHED",
        summary: `Bank line attached as evidence of an existing payment (no money moved)`,
        metadata: { externalTransactionId: line.id, evidenceId: ev.id, mode: "EXISTING_PAYMENT" },
      });
      return { evidenceId: ev.id, paymentId: payment.id, createdPayment: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new PayablesConflictError("This bank line already evidences a payment");
    throw error;
  }
}

/** The line is the transfer of an approved prepared payment. */
export async function completePreparationFromObservation(input: {
  businessId: number;
  actorUserId?: number | null;
  externalTransactionId: number;
  preparationId: number;
}) {
  try {
    return await withTenantTransaction(async (tx) => {
      const line = await assertLineOpen(tx, input.businessId, input.externalTransactionId);
      const prep = await tx.paymentPreparation.findFirst({
        where: { id: input.preparationId, businessId: input.businessId },
        select: { amount: true },
      });
      if (!prep) throw new PayablesNotFoundError("Payment preparation not found");
      if (toMinorUnits(prep.amount.toFixed(2)) !== toMinorUnits(line.amount.toFixed(2))) {
        throw new PayablesValidationError("The bank line amount differs from the prepared payment");
      }
      const result = await completePreparationInTx(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        preparationId: input.preparationId,
        paidAt: line.bookedAt,
        source: "BANK_OBSERVED",
        externalReference: line.reference,
        evidence: {
          kind: "BANK_TRANSACTION",
          note: "Prepared payment completed on the owner's confirmation of an observed bank line",
          externalTransactionId: line.id,
        },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: result.paymentId,
        eventType: "EXTERNAL_TRANSACTION_ATTACHED",
        summary: `Bank line confirmed as the transfer of a prepared payment`,
        metadata: { externalTransactionId: line.id, preparationId: input.preparationId, mode: "PREPARATION", replayed: result.replayed },
      });
      return { paymentId: result.paymentId, unallocated: result.unallocated, createdPayment: !result.replayed };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new PayablesConflictError("This bank line already evidences a payment");
    throw error;
  }
}

/**
 * A NEW Payment, evidenced by this line, for an obligation that had none. The
 * owner's explicit decision — and refused while a RECORDED Payment of the same
 * amount already exists on that commitment near that date with no bank line,
 * unless the owner states it is a different event. That is the double-count
 * door, and it stays shut by default.
 */
export async function recordPaymentFromObservation(input: {
  businessId: number;
  actorUserId?: number | null;
  externalTransactionId: number;
  commitmentId: number;
  installmentIds?: number[] | null;
  method?: string | null;
  acknowledgeSimilarPayment?: boolean;
}) {
  try {
    return await withTenantTransaction(async (tx) => {
      const line = await assertLineOpen(tx, input.businessId, input.externalTransactionId);
      const amount = line.amount.toFixed(2);
      if (!input.acknowledgeSimilarPayment) {
        const similar = await tx.payment.findFirst({
          where: {
            businessId: input.businessId,
            status: "RECORDED" as never,
            amount: line.amount,
            paidAt: {
              gte: new Date(line.bookedAt.getTime() - 14 * 86_400_000),
              lte: new Date(line.bookedAt.getTime() + 14 * 86_400_000),
            },
            allocations: { some: { reversedAt: null, installment: { commitmentId: input.commitmentId } } },
            evidences: { none: { revokedAt: null, externalTransactionId: { not: null } } },
          },
          select: { id: true },
        });
        if (similar) {
          throw new PayablesConflictError(
            "A payment of this amount is already recorded on this commitment. Attach the bank line to it instead, or confirm it is a different payment",
          );
        }
      }
      const result = await recordPaymentInTx(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: input.commitmentId,
        amount,
        paidAt: line.bookedAt,
        method: input.method ?? "BANK_TRANSFER",
        externalReference: line.reference,
        idempotencyKey: observationPaymentKey(line.id),
        installmentIds: input.installmentIds?.length ? input.installmentIds : null,
        evidence: {
          kind: "BANK_TRANSACTION",
          note: "Payment recorded on the owner's confirmation of an observed bank line",
          externalTransactionId: line.id,
        },
        auditSummary: `Payment of ${amount} ${line.currency} recorded from a bank line`,
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: result.payment.id,
        eventType: "EXTERNAL_TRANSACTION_ATTACHED",
        summary: `Bank line recorded as a new payment`,
        metadata: { externalTransactionId: line.id, mode: "NEW_PAYMENT", replayed: result.replayed },
      });
      return { paymentId: result.payment.id, unallocated: result.unallocated ?? "0.00", createdPayment: !result.replayed };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new PayablesConflictError("This bank line already evidences a payment");
    throw error;
  }
}

export async function rejectObservationPairing(input: {
  businessId: number;
  actorUserId?: number | null;
  externalTransactionId: number;
  paymentId?: number | null;
  installmentId?: number | null;
  reason?: string | null;
}) {
  if (!input.paymentId && !input.installmentId) {
    throw new PayablesValidationError("Name the payment or installment being rejected");
  }
  try {
    return await withTenantTransaction(async (tx) => {
      await loadObservation(tx, input.businessId, input.externalTransactionId);
      const row = await tx.externalTransactionMatchRejection.create({
        data: {
          businessId: input.businessId,
          externalTransactionId: input.externalTransactionId,
          paymentId: input.paymentId ?? null,
          installmentId: input.installmentId ?? null,
          reason: input.reason?.trim().slice(0, 500) || null,
          rejectedByUserId: input.actorUserId ?? null,
        },
        select: { id: true },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        eventType: "EXTERNAL_TRANSACTION_REJECTED",
        summary: `A suggested pairing for a bank line was rejected by the owner`,
        metadata: { externalTransactionId: input.externalTransactionId, paymentId: input.paymentId ?? null, installmentId: input.installmentId ?? null },
      });
      return { rejectionId: row.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { rejectionId: null, alreadyRejected: true };
    throw error;
  }
}

export async function dismissObservation(input: {
  businessId: number;
  actorUserId?: number | null;
  externalTransactionId: number;
  reason?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const line = await assertLineOpen(tx, input.businessId, input.externalTransactionId);
    await tx.externalTransaction.update({
      where: { id: line.id },
      data: {
        dismissedAt: new Date(),
        dismissedByUserId: input.actorUserId ?? null,
        dismissReason: input.reason?.trim().slice(0, 300) || null,
      },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "EXTERNAL_TRANSACTION_DISMISSED",
      summary: `A bank line was marked as not a payable`,
      metadata: { externalTransactionId: line.id },
    });
    return { dismissed: true };
  });
}

/** Revoke a bank-line evidence. The Payment stays exactly as it was: evidence never moves money. */
export async function revokeObservationEvidence(input: {
  businessId: number;
  actorUserId?: number | null;
  evidenceId: number;
  reason?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const ev = await tx.paymentEvidence.findFirst({
      where: { id: input.evidenceId, businessId: input.businessId, externalTransactionId: { not: null } },
      select: { id: true, paymentId: true, revokedAt: true, externalTransactionId: true },
    });
    if (!ev) throw new PayablesNotFoundError("Bank-line evidence not found");
    if (ev.revokedAt) return { revoked: true, paymentId: ev.paymentId };
    await tx.paymentEvidence.update({
      where: { id: ev.id },
      data: {
        revokedAt: new Date(),
        revokedByUserId: input.actorUserId ?? null,
        revocationReason: input.reason?.trim().slice(0, 500) || null,
      },
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      paymentId: ev.paymentId,
      eventType: "EXTERNAL_EVIDENCE_REVOKED",
      summary: `A bank line was detached from a payment (the payment is unchanged)`,
      metadata: { evidenceId: ev.id, externalTransactionId: ev.externalTransactionId },
    });
    return { revoked: true, paymentId: ev.paymentId };
  });
}
