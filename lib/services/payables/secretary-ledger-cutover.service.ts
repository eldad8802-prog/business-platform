/**
 * Secretary → ledger cutover (Phase 2) — the ONE-TIME data move that must
 * accompany turning `SECRETARY_LEDGER_STORE` on. SCRIPT-ONLY: never import this
 * from a route, a page or the runtime. Run it through
 * `scripts/payables/secretary-ledger-cutover.ts`, whose default is a dry run.
 *
 * Why it is needed. Migration 20260917090200 copied every `BusinessObligation`
 * into the ledger ONCE. The secretary kept writing `BusinessObligation` after
 * that, with no dual-write, so Production now holds three kinds of drift:
 *
 *   A. UNCOPIED    obligations created after the backfill — only in the old table
 *   B. DRIFTED     copied obligations the secretary changed afterwards (marked
 *                  done, released, re-dated, re-priced, snoozed, renamed) —
 *                  the ledger still shows them as they were on 2026-09-17
 *   C. INVARIANT   migrated RECURRING commitments carrying `totalAmount`, which
 *                  the ledger forbids (a recurring commitment has no total)
 *
 * Rules — the backfill's own (programme §13), unchanged:
 *   - Nothing is deleted; `BusinessObligation` stays, read-only, for rollback.
 *   - A legacy "MET" is a SETTLED_LEGACY assertion — NEVER a synthesized Payment.
 *   - A drifted row whose installment already carries money is a CONFLICT: it is
 *     reported and left alone, never rewritten under a real payment.
 *   - Every change is audited (`PayablesAuditEvent`, source MIGRATION).
 *   - Idempotent: a second run finds nothing to do.
 *
 * Each business is processed in its own transaction with the tenant GUC set,
 * so under a runtime role RLS still scopes every statement to that business.
 * Output is counts and row ids only — never a name, a note or an amount.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { hashAuditEvent } from "./payables.service";

type Tx = Prisma.TransactionClient;

export type CutoverCounts = {
  businesses: number;
  obligations: number;
  alreadyCopied: number;
  uncopied: { OPEN: number; MET: number; RELEASED: number; recurring: number };
  drift: {
    metNotSettled: number;
    releasedNotReleased: number;
    amountChanged: number;
    dueAtChanged: number;
    renamed: number;
    noteChanged: number;
    followUpToCopy: number;
  };
  conflicts: Array<{ businessId: number; obligationId: number; installmentId: number; reason: string }>;
  recurringWithTotalAmount: number;
};

export type CutoverReport = {
  mode: "dry-run" | "execute";
  before: CutoverCounts;
  applied?: { copied: number; synced: number; totalsCleared: number };
  after?: CutoverCounts;
};

type Obligation = {
  id: number;
  businessId: number;
  obligeeName: string;
  amount: Prisma.Decimal;
  currency: string;
  dueAt: Date;
  state: string;
  recurrence: string;
  recurrenceSeriesId: string | null;
  note: string | null;
  followUpAt: Date | null;
  settlementAssertedBy: string | null;
  metAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Copied = {
  id: number;
  businessId: number;
  legacyObligationId: number | null;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  scheduleKind: string;
  status: string;
  note: string | null;
  totalAmount: Prisma.Decimal | null;
  installments: Array<{
    id: number;
    sequence: number;
    scheduledAmount: Prisma.Decimal;
    dueAt: Date;
    status: string;
    allocations: Array<{ reversedAt: Date | null; payment: { status: string } }>;
    workflow: { followUpAt: Date | null } | null;
  }>;
};

/** What one copied obligation needs, decided from the two rows alone. Pure. */
export function diffCopied(o: Obligation, c: Copied): {
  metNotSettled: boolean;
  releasedNotReleased: boolean;
  amountChanged: boolean;
  dueAtChanged: boolean;
  renamed: boolean;
  noteChanged: boolean;
  followUpToCopy: boolean;
  conflict: string | null;
} {
  const inst = c.installments.find((i) => i.sequence === 1) ?? c.installments[0];
  const paid = inst ? inst.allocations.some((a) => a.reversedAt === null && a.payment.status === "RECORDED") : false;
  const metNotSettled = o.state === "MET" && inst?.status === "SCHEDULED";
  const releasedNotReleased = o.state === "RELEASED" && c.status !== "RELEASED";
  const open = o.state === "OPEN";
  const amountChanged = open && !!inst && !inst.scheduledAmount.equals(o.amount);
  const dueAtChanged = open && !!inst && inst.dueAt.getTime() !== o.dueAt.getTime();
  const renamed = o.obligeeName !== c.payeeNameSnapshot && c.payeeId === null;
  const noteChanged = (o.note ?? null) !== (c.note ?? null);
  const followUpToCopy =
    open && o.followUpAt !== null && !!inst && (inst.workflow?.followUpAt?.getTime() ?? null) !== o.followUpAt.getTime();
  const moneyDrift = metNotSettled || releasedNotReleased || amountChanged || dueAtChanged;
  return {
    metNotSettled,
    releasedNotReleased,
    amountChanged,
    dueAtChanged,
    renamed,
    noteChanged,
    followUpToCopy,
    conflict: moneyDrift && paid ? "installment already carries a payment" : null,
  };
}

async function loadBusiness(tx: Tx, businessId: number) {
  const obligations: Obligation[] = await tx.businessObligation.findMany({
    where: { businessId },
    orderBy: { id: "asc" },
  });
  const copied: Copied[] = await tx.commitment.findMany({
    where: { businessId, legacyObligationId: { not: null } },
    select: {
      id: true,
      businessId: true,
      legacyObligationId: true,
      title: true,
      payeeId: true,
      payeeNameSnapshot: true,
      scheduleKind: true,
      status: true,
      note: true,
      totalAmount: true,
      installments: {
        where: { businessId },
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          scheduledAmount: true,
          dueAt: true,
          status: true,
          allocations: { select: { reversedAt: true, payment: { select: { status: true } } } },
          workflow: { select: { followUpAt: true } },
        },
      },
    },
  });
  return { obligations, copied };
}

function emptyCounts(): CutoverCounts {
  return {
    businesses: 0,
    obligations: 0,
    alreadyCopied: 0,
    uncopied: { OPEN: 0, MET: 0, RELEASED: 0, recurring: 0 },
    drift: {
      metNotSettled: 0,
      releasedNotReleased: 0,
      amountChanged: 0,
      dueAtChanged: 0,
      renamed: 0,
      noteChanged: 0,
      followUpToCopy: 0,
    },
    conflicts: [],
    recurringWithTotalAmount: 0,
  };
}

function countInto(total: CutoverCounts, obligations: Obligation[], copied: Copied[]): void {
  const byLegacy = new Map(copied.map((c) => [c.legacyObligationId!, c]));
  if (obligations.length > 0 || copied.length > 0) total.businesses += 1;
  total.obligations += obligations.length;
  for (const o of obligations) {
    const c = byLegacy.get(o.id);
    if (!c) {
      const state = (o.state in total.uncopied ? o.state : "OPEN") as "OPEN" | "MET" | "RELEASED";
      total.uncopied[state] += 1;
      if (o.recurrence !== "NONE") total.uncopied.recurring += 1;
      continue;
    }
    total.alreadyCopied += 1;
    const d = diffCopied(o, c);
    for (const k of Object.keys(total.drift) as Array<keyof CutoverCounts["drift"]>) if (d[k]) total.drift[k] += 1;
    if (d.conflict) {
      total.conflicts.push({
        businessId: o.businessId,
        obligationId: o.id,
        installmentId: c.installments[0]?.id ?? 0,
        reason: d.conflict,
      });
    }
  }
  total.recurringWithTotalAmount += copied.filter((c) => c.scheduleKind === "RECURRING" && c.totalAmount !== null).length;
}

async function audit(
  tx: Tx,
  input: { businessId: number; commitmentId: number; installmentId?: number; eventType: string; summary: string; metadata: Record<string, unknown> },
): Promise<void> {
  const occurredAt = new Date();
  await tx.payablesAuditEvent.create({
    data: {
      businessId: input.businessId,
      commitmentId: input.commitmentId,
      installmentId: input.installmentId ?? null,
      eventType: input.eventType,
      source: "MIGRATION",
      summary: input.summary,
      metadata: input.metadata as Prisma.InputJsonValue,
      eventHash: hashAuditEvent({ ...input, source: "MIGRATION", occurredAt: occurredAt.toISOString() }),
      occurredAt,
    },
  });
}

async function applyBusiness(tx: Tx, obligations: Obligation[], copied: Copied[]) {
  const byLegacy = new Map(copied.map((c) => [c.legacyObligationId!, c]));
  let copiedCount = 0;
  let synced = 0;

  for (const o of obligations) {
    const c = byLegacy.get(o.id);

    if (!c) {
      // ── A. copy — the backfill's §13 mapping, with the recurring invariant kept
      const recurring = o.recurrence !== "NONE";
      const commitment = await tx.commitment.create({
        data: {
          businessId: o.businessId,
          title: o.obligeeName,
          payeeNameSnapshot: o.obligeeName,
          currency: o.currency,
          totalAmount: recurring ? null : o.amount,
          scheduleKind: recurring ? "RECURRING" : "ONE_OFF",
          recurrence: o.recurrence,
          recurrenceSeriesId: o.recurrenceSeriesId,
          status: o.state === "MET" ? "CLOSED" : o.state === "RELEASED" ? "RELEASED" : "ACTIVE",
          note: o.note,
          legacyObligationId: o.id,
          createdAt: o.createdAt,
        },
      });
      const installment = await tx.installment.create({
        data: {
          businessId: o.businessId,
          commitmentId: commitment.id,
          sequence: 1,
          scheduledAmount: o.amount,
          currency: o.currency,
          dueAt: o.dueAt,
          status: o.state === "MET" ? "SETTLED_LEGACY" : "SCHEDULED",
          legacySettlementAssertedBy: o.state === "MET" ? o.settlementAssertedBy : null,
          legacyMetAt: o.state === "MET" ? o.metAt : null,
          createdAt: o.createdAt,
        },
      });
      if (o.state === "OPEN" && o.followUpAt) {
        await tx.installmentWorkflow.create({
          data: { installmentId: installment.id, businessId: o.businessId, followUpAt: o.followUpAt },
        });
      }
      await audit(tx, {
        businessId: o.businessId,
        commitmentId: commitment.id,
        installmentId: installment.id,
        eventType: "COMMITMENT_MIGRATED_FROM_OBLIGATION",
        summary: `Migrated from BusinessObligation #${o.id} (secretary cutover)`,
        metadata: { legacyObligationId: o.id, legacyState: o.state, synthesizedPayment: false, phase: "P2_CUTOVER" },
      });
      copiedCount += 1;
      continue;
    }

    // ── B. sync a copied row the secretary changed after the backfill
    const d = diffCopied(o, c);
    const inst = c.installments.find((i) => i.sequence === 1) ?? c.installments[0];
    const changed: string[] = [];
    if (!d.conflict && inst) {
      if (d.metNotSettled) {
        await tx.installment.update({
          where: { id: inst.id },
          data: { status: "SETTLED_LEGACY", legacySettlementAssertedBy: o.settlementAssertedBy, legacyMetAt: o.metAt },
        });
        await tx.commitment.update({ where: { id: c.id }, data: { status: "CLOSED" } });
        changed.push("state:MET");
      }
      if (d.releasedNotReleased) {
        await tx.commitment.update({ where: { id: c.id }, data: { status: "RELEASED" } });
        changed.push("state:RELEASED");
      }
      if (d.amountChanged || d.dueAtChanged) {
        await tx.installment.update({
          where: { id: inst.id },
          data: { scheduledAmount: o.amount, dueAt: o.dueAt },
        });
        if (c.scheduleKind === "ONE_OFF") {
          await tx.commitment.update({ where: { id: c.id }, data: { totalAmount: o.amount } });
        }
        if (d.amountChanged) changed.push("amount");
        if (d.dueAtChanged) changed.push("dueAt");
      }
    }
    // Non-financial drift is safe to sync even when the row carries money.
    if (d.renamed) {
      await tx.commitment.update({ where: { id: c.id }, data: { title: o.obligeeName, payeeNameSnapshot: o.obligeeName } });
      changed.push("name");
    }
    if (d.noteChanged) {
      await tx.commitment.update({ where: { id: c.id }, data: { note: o.note } });
      changed.push("note");
    }
    if (d.followUpToCopy && inst) {
      await tx.installmentWorkflow.upsert({
        where: { installmentId: inst.id },
        create: { installmentId: inst.id, businessId: o.businessId, followUpAt: o.followUpAt },
        update: { followUpAt: o.followUpAt },
      });
      changed.push("followUpAt");
    }
    if (changed.length > 0) {
      await audit(tx, {
        businessId: o.businessId,
        commitmentId: c.id,
        installmentId: inst?.id,
        eventType: "COMMITMENT_SYNCED_FROM_OBLIGATION",
        summary: `Synced from BusinessObligation #${o.id} (secretary cutover)`,
        metadata: { legacyObligationId: o.id, changed, synthesizedPayment: false, phase: "P2_CUTOVER" },
      });
      synced += 1;
    }
  }

  // ── C. the recurring invariant: a RECURRING commitment has no total
  let totalsCleared = 0;
  for (const c of copied) {
    if (c.scheduleKind === "RECURRING" && c.totalAmount !== null) {
      await tx.commitment.update({ where: { id: c.id }, data: { totalAmount: null } });
      await audit(tx, {
        businessId: c.businessId,
        commitmentId: c.id,
        eventType: "COMMITMENT_UPDATED",
        summary: "Recurring commitment total cleared (ledger invariant; migrated value)",
        metadata: { field: "totalAmount", before: c.totalAmount.toString(), after: null, phase: "P2_CUTOVER" },
      });
      totalsCleared += 1;
    }
  }
  return { copied: copiedCount, synced, totalsCleared };
}

async function businessIds(db: PrismaClient): Promise<number[]> {
  const rows = await db.businessObligation.findMany({ distinct: ["businessId"], select: { businessId: true } });
  const more = await db.commitment.findMany({
    where: { legacyObligationId: { not: null } },
    distinct: ["businessId"],
    select: { businessId: true },
  });
  return [...new Set([...rows, ...more].map((r) => r.businessId))].sort((a, b) => a - b);
}

async function inTenant<T>(db: PrismaClient, businessId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(tx);
    },
    { timeout: 120_000 },
  );
}

async function countAll(db: PrismaClient, onlyBusinessIds?: number[]): Promise<CutoverCounts> {
  const total = emptyCounts();
  for (const businessId of onlyBusinessIds ?? (await businessIds(db))) {
    const { obligations, copied } = await inTenant(db, businessId, (tx) => loadBusiness(tx, businessId));
    countInto(total, obligations, copied);
  }
  return total;
}

/**
 * Dry run: counts only, no write. Execute: apply per business, then count
 * again — `after` must show zero uncopied, zero drift outside `conflicts`, and
 * zero recurring totals, or the cutover is not complete.
 */
export async function runSecretaryLedgerCutover(
  db: PrismaClient,
  options: { mode: "dry-run" | "execute"; onlyBusinessIds?: number[] },
): Promise<CutoverReport> {
  const before = await countAll(db, options.onlyBusinessIds);
  if (options.mode === "dry-run") return { mode: "dry-run", before };

  const applied = { copied: 0, synced: 0, totalsCleared: 0 };
  for (const businessId of options.onlyBusinessIds ?? (await businessIds(db))) {
    const r = await inTenant(db, businessId, async (tx) => {
      const { obligations, copied } = await loadBusiness(tx, businessId);
      return applyBusiness(tx, obligations, copied);
    });
    applied.copied += r.copied;
    applied.synced += r.synced;
    applied.totalsCleared += r.totalsCleared;
  }
  const after = await countAll(db, options.onlyBusinessIds);
  return { mode: "execute", before, applied, after };
}
