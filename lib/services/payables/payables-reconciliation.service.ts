/**
 * Payables — document reconciliation.
 *
 * Connects approved documents to the payable ledger. The whole module turns on
 * one distinction:
 *
 *   A receipt is EVIDENCE that a payment happened.
 *   A receipt is NOT, by itself, a payment.
 *
 * Both directions of the double-count invariant live here:
 *
 *   payment first, receipt later  → the document is attached to the EXISTING
 *                                   payment as evidence. No second Payment,
 *                                   no second allocation, no second amount.
 *
 *   receipt first, payment later  → a high score creates NOTHING. The owner
 *                                   decides whether it evidences a payment
 *                                   already recorded, or is itself a new
 *                                   economic event worth recording.
 *
 * Nothing here auto-confirms. `suggest` reads and scores; every function that
 * changes the ledger requires an explicit owner decision to have been made, and
 * writes an audit row saying who decided what.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesNotFoundError,
  PayablesValidationError,
  fromMinorUnits,
  toMinorUnits,
} from "./payables-core";
import {
  confidenceOf,
  financialRecordAmountToMinor,
  rankCandidates,
  scoreCandidate,
  type Candidate,
  type CandidateTarget,
  type DocumentFacts,
} from "./payables-matching";
import { hashAuditEvent, recordManualPayment } from "./payables.service";

type Tx = Prisma.TransactionClient;

/* ───────────────────────────────── audit ─────────────────────────────────── */

async function writeReconciliationAudit(
  tx: Tx,
  input: {
    businessId: number;
    eventType:
      | "DOCUMENT_EVIDENCE_ATTACHED"
      | "DOCUMENT_EVIDENCE_REVOKED"
      | "EVIDENCE_REVOKED"
      | "DOCUMENT_MATCH_REJECTED"
      | "PAYMENT_RECORDED_FROM_DOCUMENT";
    summary: string;
    actorUserId?: number | null;
    commitmentId?: number | null;
    installmentId?: number | null;
    paymentId?: number | null;
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
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      source: "USER",
      summary: input.summary,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      // The SAME hasher and the SAME input shape as every Phase 1a audit row.
      // The trail is append-only, so each row has to be independently
      // checkable; a reconciliation event with an empty hash would be the one
      // row nobody could verify, which is exactly the row worth forging.
      eventHash: hashAuditEvent({
        businessId: input.businessId,
        eventType: input.eventType,
        summary: input.summary,
        commitmentId: input.commitmentId ?? null,
        paymentId: input.paymentId ?? null,
        allocationId: null,
        actorUserId: input.actorUserId ?? null,
        metadata: input.metadata ?? null,
        occurredAt: occurredAt.toISOString(),
      }),
      occurredAt,
    },
  });
}

/* ──────────────────────────────── suggest ────────────────────────────────── */

export type SuggestionResult = {
  document: {
    id: number;
    amount: string;
    date: Date;
    vendorName: string;
    direction: string;
  };
  candidates: Array<
    Candidate & { confidence: ReturnType<typeof confidenceOf> }
  >;
  ambiguous: boolean;
  /** Set when the document is already attached to a payment. */
  attachedTo: { paymentId: number; evidenceId: number } | null;
};

/**
 * What this document might be, ranked — and nothing more.
 *
 * Candidates are derived on every call from current facts. They are never
 * stored: a saved candidate goes stale the moment a payment is voided or an
 * instalment is cancelled, and a stale suggestion is worse than none because it
 * carries the authority of having been written down.
 */
export async function suggestMatchesForDocument(input: {
  businessId: number;
  documentId: number;
  now?: Date;
}): Promise<SuggestionResult> {


  return withTenantTransaction(async (tx) => {
    const record = await tx.financialRecord.findFirst({
      where: { documentId: input.documentId, businessId: input.businessId },
      select: {
        id: true,
        documentId: true,
        amount: true,
        date: true,
        vendorName: true,
        direction: true,
      },
    });
    if (!record) {
      // Either the document does not exist for this tenant, or it has not been
      // approved into a FinancialRecord yet. Both are "nothing to match".
      throw new PayablesNotFoundError("No approved financial record for this document");
    }

    const facts: DocumentFacts = {
      documentId: record.documentId,
      financialRecordId: record.id,
      // The ONLY float → ledger crossing, through the canonical converter.
      amountMinor: financialRecordAmountToMinor(record.amount),
      date: record.date,
      vendorName: record.vendorName,
      direction: record.direction,
    };

    const existing = await tx.paymentEvidence.findFirst({
      where: {
        businessId: input.businessId,
        documentId: input.documentId,
        revokedAt: null,
      },
      select: { id: true, paymentId: true },
    });

    const rejections = await tx.payablesMatchRejection.findMany({
      where: { businessId: input.businessId, documentId: input.documentId },
      select: { commitmentId: true, installmentId: true, paymentId: true },
    });
    const rejected = new Set(
      rejections.map(
        (r) => `${r.commitmentId ?? 0}:${r.installmentId ?? 0}:${r.paymentId ?? 0}`,
      ),
    );

    // Payments the owner has already recorded — the "payment first, receipt
    // later" direction, which is the one that must NOT create a second payment.
    const payments = await tx.payment.findMany({
      where: { businessId: input.businessId, status: "RECORDED" },
      select: {
        id: true,
        amount: true,
        paidAt: true,
        payeeNameSnapshot: true,
        payeeId: true,
        allocations: {
          where: { reversedAt: null },
          select: { installment: { select: { commitmentId: true } } },
          take: 1,
        },
        evidences: {
          where: { revokedAt: null, documentId: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { paidAt: "desc" },
      take: 200,
    });

    // Instalments that still owe something — the "receipt first" direction.
    const installments = await tx.installment.findMany({
      where: {
        businessId: input.businessId,
        status: "SCHEDULED",
        commitment: { status: "ACTIVE" },
      },
      select: {
        id: true,
        commitmentId: true,
        scheduledAmount: true,
        dueAt: true,
        commitment: {
          select: { title: true, payeeNameSnapshot: true, payeeId: true },
        },
        allocations: {
          where: { reversedAt: null },
          select: { allocatedAmount: true, payment: { select: { status: true } } },
        },
      },
      orderBy: { dueAt: "asc" },
      take: 200,
    });

    const targets: CandidateTarget[] = [];

    for (const p of payments) {
      const commitmentId = p.allocations[0]?.installment.commitmentId ?? null;
      if (commitmentId === null) continue;
      const commitment = await tx.commitment.findFirst({
        where: { id: commitmentId, businessId: input.businessId },
        select: { title: true },
      });
      targets.push({
        kind: "PAYMENT",
        paymentId: p.id,
        commitmentId,
        commitmentTitle: commitment?.title ?? "",
        payeeNameSnapshot: p.payeeNameSnapshot,
        payeeId: p.payeeId,
        amountMinor: toMinorUnits(p.amount.toString()),
        paidAt: p.paidAt,
        hasDocumentEvidence: p.evidences.length > 0,
      });
    }

    for (const i of installments) {
      const scheduledMinor = toMinorUnits(i.scheduledAmount.toString());
      const paidMinor = i.allocations
        .filter((a) => a.payment.status === "RECORDED")
        .reduce((s, a) => s + toMinorUnits(a.allocatedAmount.toString()), 0);
      const remainingMinor = Math.max(0, scheduledMinor - paidMinor);
      if (remainingMinor === 0) continue;
      targets.push({
        kind: "INSTALLMENT",
        installmentId: i.id,
        commitmentId: i.commitmentId,
        commitmentTitle: i.commitment.title,
        payeeNameSnapshot: i.commitment.payeeNameSnapshot,
        payeeId: i.commitment.payeeId,
        remainingMinor,
        dueAt: i.dueAt,
      });
    }

    const scored: Candidate[] = [];
    for (const target of targets) {
      const key =
        target.kind === "PAYMENT"
          ? `${target.commitmentId}:0:${target.paymentId}`
          : `${target.commitmentId}:${target.installmentId}:0`;
      if (rejected.has(key)) continue;
      // A whole-commitment rejection suppresses its parts too.
      if (rejected.has(`${target.commitmentId}:0:0`)) continue;

      const candidate = scoreCandidate(facts, target);
      if (candidate) scored.push(candidate);
    }

    const { ranked, ambiguous } = rankCandidates(scored);

    return {
      document: {
        id: record.documentId,
        amount: fromMinorUnits(facts.amountMinor),
        date: facts.date,
        vendorName: facts.vendorName,
        direction: facts.direction,
      },
      candidates: ranked.map((c) => ({ ...c, confidence: confidenceOf(c) })),
      ambiguous,
      attachedTo: existing
        ? { paymentId: existing.paymentId, evidenceId: existing.id }
        : null,
    };
  });
}

/* ──────────────────────── confirm: evidence only ─────────────────────────── */

/**
 * The owner says: this document is the receipt for a payment I already
 * recorded.
 *
 * Attaches DOCUMENT evidence to that payment and changes NOTHING about the
 * money. No Payment is created, no allocation is made, no balance moves — the
 * payment was already an economic fact and this only records that a piece of
 * paper corroborates it.
 *
 * The partial unique index is the backstop: if the document is already attached
 * to a payment, the database refuses rather than letting one receipt justify two
 * payments.
 */
export async function attachDocumentEvidence(input: {
  businessId: number;
  documentId: number;
  paymentId: number;
  actorUserId?: number | null;
  note?: string | null;
}) {
  return withTenantTransaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, businessId: input.businessId },
      select: { id: true, status: true, amount: true },
    });
    if (!payment) throw new PayablesNotFoundError("Payment not found");
    if (payment.status !== "RECORDED") {
      throw new PayablesValidationError(
        "A voided payment cannot take on new evidence",
      );
    }

    const record = await tx.financialRecord.findFirst({
      where: { documentId: input.documentId, businessId: input.businessId },
      select: { id: true },
    });
    if (!record) {
      throw new PayablesNotFoundError("No approved financial record for this document");
    }

    const already = await tx.paymentEvidence.findFirst({
      where: {
        businessId: input.businessId,
        documentId: input.documentId,
        revokedAt: null,
      },
      select: { id: true, paymentId: true },
    });
    if (already) {
      if (already.paymentId === input.paymentId) {
        // Idempotent: asking twice is the same answer, not a second attachment.
        return already;
      }
      throw new PayablesValidationError(
        "This document is already attached to another payment. Revoke that first.",
      );
    }

    const evidence = await tx.paymentEvidence.create({
      data: {
        businessId: input.businessId,
        paymentId: input.paymentId,
        kind: "DOCUMENT",
        documentId: input.documentId,
        financialRecordId: record.id,
        assertedByUserId: input.actorUserId ?? null,
        note: input.note?.trim() || null,
      },
    });

    await writeReconciliationAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      paymentId: input.paymentId,
      eventType: "DOCUMENT_EVIDENCE_ATTACHED",
      summary: `Document #${input.documentId} attached as evidence for payment #${input.paymentId}`,
      metadata: {
        documentId: input.documentId,
        financialRecordId: record.id,
        createdPayment: false,
      },
    });

    return evidence;
  });
}

/* ───────────────────── confirm: a NEW economic payment ───────────────────── */

/**
 * The owner says: this document is a payment I made and never recorded.
 *
 * Only here is a Payment created from a document, and only because a person
 * said so. A score never reaches this function — `suggest` cannot call it, the
 * API requires an explicit action, and the resulting Payment is an ordinary
 * manual payment that happens to carry DOCUMENT evidence from birth.
 *
 * The amount comes from the document's approved reading, converted once through
 * the canonical minor-unit boundary and passed to the ledger as a decimal
 * string — no float ever reaches `recordManualPayment`.
 */
export async function recordPaymentFromDocument(input: {
  businessId: number;
  documentId: number;
  commitmentId: number;
  installmentIds?: number[] | null;
  method: string;
  actorUserId?: number | null;
  idempotencyKey?: string | null;
  note?: string | null;
}) {
  // Read the document's facts in their own transaction first: `recordManualPayment`
  // opens its own, and nesting tenant transactions is refused by design.
  const record = await withTenantTransaction(async (tx) => {
    const row = await tx.financialRecord.findFirst({
      where: { documentId: input.documentId, businessId: input.businessId },
      select: { id: true, amount: true, date: true, direction: true },
    });
    if (!row) {
      throw new PayablesNotFoundError("No approved financial record for this document");
    }
    if (row.direction !== "expense") {
      throw new PayablesValidationError(
        "Only an expense document can become an outbound payment",
      );
    }
    const attached = await tx.paymentEvidence.findFirst({
      where: {
        businessId: input.businessId,
        documentId: input.documentId,
        revokedAt: null,
      },
      select: { paymentId: true },
    });
    if (attached) {
      // The direction that prevents the double count: this receipt has already
      // been accounted for, so it must not also mint a payment.
      throw new PayablesValidationError(
        `This document already evidences payment #${attached.paymentId}. Recording it again would count the same money twice.`,
      );
    }
    return row;
  });

  const amountMinor = financialRecordAmountToMinor(record.amount);

  const result = await recordManualPayment({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    commitmentId: input.commitmentId,
    amount: fromMinorUnits(amountMinor),
    paidAt: record.date,
    method: input.method,
    note: input.note ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    installmentIds: input.installmentIds ?? null,
  });

  // Attach the evidence to the payment that was just created, so the document
  // and the economic event it justifies are linked from the start.
  const evidence = await attachDocumentEvidence({
    businessId: input.businessId,
    documentId: input.documentId,
    paymentId: result.payment.id,
    actorUserId: input.actorUserId,
    note: "נרשם מתוך המסמך",
  });

  await withTenantTransaction((tx) =>
    writeReconciliationAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: input.commitmentId,
      paymentId: result.payment.id,
      eventType: "PAYMENT_RECORDED_FROM_DOCUMENT",
      summary: `Payment #${result.payment.id} recorded from document #${input.documentId}`,
      metadata: {
        documentId: input.documentId,
        financialRecordId: record.id,
        createdPayment: true,
        replayed: result.replayed,
      },
    }),
  );

  return { ...result, evidence };
}

/* ───────────────────────────── reject / revoke ───────────────────────────── */

/** The owner says: not this one. Recorded so it stops being suggested. */
export async function rejectMatch(input: {
  businessId: number;
  documentId: number;
  commitmentId?: number | null;
  installmentId?: number | null;
  paymentId?: number | null;
  reason?: string | null;
  actorUserId?: number | null;
}) {
  return withTenantTransaction(async (tx) => {
    const record = await tx.financialRecord.findFirst({
      where: { documentId: input.documentId, businessId: input.businessId },
      select: { id: true },
    });
    if (!record) {
      throw new PayablesNotFoundError("No approved financial record for this document");
    }

    const existing = await tx.payablesMatchRejection.findFirst({
      where: {
        businessId: input.businessId,
        documentId: input.documentId,
        commitmentId: input.commitmentId ?? null,
        installmentId: input.installmentId ?? null,
        paymentId: input.paymentId ?? null,
      },
    });
    // Rejecting twice is the same decision, not a new one.
    if (existing) return existing;

    const rejection = await tx.payablesMatchRejection.create({
      data: {
        businessId: input.businessId,
        documentId: input.documentId,
        commitmentId: input.commitmentId ?? null,
        installmentId: input.installmentId ?? null,
        paymentId: input.paymentId ?? null,
        reason: input.reason?.trim() || null,
        rejectedByUserId: input.actorUserId ?? null,
      },
    });

    await writeReconciliationAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      commitmentId: input.commitmentId ?? null,
      installmentId: input.installmentId ?? null,
      paymentId: input.paymentId ?? null,
      eventType: "DOCUMENT_MATCH_REJECTED",
      summary: `Document #${input.documentId} rejected as a match`,
      metadata: { documentId: input.documentId, reason: input.reason ?? null },
    });

    return rejection;
  });
}

/**
 * Undo an attachment. The row is kept and stamped, never deleted — the same
 * contract as reversing an allocation, and what makes the partial unique index
 * partial in the first place.
 */
export async function revokeDocumentEvidence(input: {
  businessId: number;
  evidenceId: number;
  reason?: string | null;
  actorUserId?: number | null;
}) {
  return withTenantTransaction(async (tx) => {
    const evidence = await tx.paymentEvidence.findFirst({
      where: { id: input.evidenceId, businessId: input.businessId },
      select: { id: true, paymentId: true, documentId: true, revokedAt: true, kind: true },
    });
    if (!evidence) throw new PayablesNotFoundError("Evidence not found");
    if (evidence.revokedAt !== null) {
      throw new PayablesValidationError("This evidence is already revoked");
    }

    const revoked = await tx.paymentEvidence.update({
      where: { id: evidence.id },
      data: {
        revokedAt: new Date(),
        revokedByUserId: input.actorUserId ?? null,
        revocationReason: input.reason?.trim() || null,
      },
    });

    // The trail records what was actually revoked. This path accepts any evidence kind (which kinds
    // may be revoked here is a product decision, unchanged); only DOCUMENT evidence is logged as a
    // document revocation — every other kind says what it was.
    if (evidence.kind === "DOCUMENT") {
      await writeReconciliationAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: evidence.paymentId,
        eventType: "DOCUMENT_EVIDENCE_REVOKED",
        summary: `Document evidence #${evidence.id} revoked from payment #${evidence.paymentId}`,
        metadata: {
          documentId: evidence.documentId,
          reason: input.reason ?? null,
        },
      });
    } else {
      await writeReconciliationAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: evidence.paymentId,
        eventType: "EVIDENCE_REVOKED",
        summary: `${evidence.kind} evidence #${evidence.id} revoked from payment #${evidence.paymentId}`,
        metadata: {
          kind: evidence.kind,
          evidenceId: evidence.id,
          documentId: evidence.documentId,
          reason: input.reason ?? null,
        },
      });
    }

    return revoked;
  });
}
