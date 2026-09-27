/**
 * The secretary's store, backed by the payables LEDGER (Phase 2).
 *
 * Implements the same `ObligationStore` port as the legacy
 * `BusinessObligation` store, so the secretary service, its routes, the Home
 * briefing and the UI are unchanged — only where the truth lives moves:
 *
 *   an "obligation" the secretary shows  =  one Installment of a Commitment
 *   its id                               =  the installment id
 *   OPEN / MET / RELEASED                =  DERIVED, never stored:
 *       RELEASED  the installment was cancelled, or the commitment released
 *       MET       the ledger says it is paid, OR a legacy settled assertion,
 *                 OR the owner pressed "טופל" (InstallmentWorkflow.handledAt)
 *       OPEN      otherwise
 *
 * THE INVARIANT: handled ≠ paid.
 *   "טופל" writes `InstallmentWorkflow.handledAt` and nothing else. It creates
 *   no Payment, no allocation and no installment status. Money moves only
 *   through the payables payment flow, which the UI calls when the owner
 *   answers "שילמת?" with yes. Snooze writes `followUpAt` there too, and never
 *   touches a due date. The Daily Business Cost engine reads neither.
 *
 * Every write goes through the payables service's *InTx functions, inside the
 * route's tenant transaction, so the secretary cannot create or change a
 * commitment by any rule the payables screen does not also obey.
 */

import { Prisma } from "@prisma/client";
import type { TenantTx } from "@/lib/tenant/transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  civilDayStart,
  deriveInstallmentBalance,
  fromMinorUnits,
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
  toMinorUnits,
  type RecurrenceCadenceValue,
} from "@/lib/services/payables/payables-core";
import {
  cancelInstallmentInTx,
  createCommitmentInTx,
  endCommitmentInTx,
  materialiseNextRecurringInstallmentInTx,
  toFacts,
  writeAudit,
} from "@/lib/services/payables/payables.service";
import { createObligationPrismaStore } from "./obligation-store.prisma";
import type {
  CreateObligationRow,
  ListObligationsOptions,
  ObligationLifecycleState,
  ObligationPatch,
  ObligationRecord,
  ObligationStore,
  RecurrenceCadence,
} from "./obligations.types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ROW_INCLUDE = {
  commitment: {
    select: {
      id: true,
      title: true,
      payeeId: true,
      payeeNameSnapshot: true,
      currency: true,
      scheduleKind: true,
      recurrence: true,
      recurrenceSeriesId: true,
      status: true,
      note: true,
      endAt: true,
      updatedAt: true,
    },
  },
  workflow: true,
  allocations: { include: { payment: { select: { status: true, paidAt: true } } } },
} satisfies Prisma.InstallmentInclude;

type Row = Prisma.InstallmentGetPayload<{ include: typeof ROW_INCLUDE }>;

/** Translate the payables domain's errors into the secretary's HTTP errors. */
async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PayablesNotFoundError) throw new NotFoundError(e.message);
    if (e instanceof PayablesValidationError) throw new ValidationError(e.message);
    if (e instanceof PayablesConflictError) throw new ConflictError("PAYABLES_CONFLICT", e.message);
    throw e;
  }
}

/** The derived secretary view of one installment. Pure over the loaded row. */
export function toObligationRecord(row: Row, now: Date = new Date()): ObligationRecord {
  const balance = deriveInstallmentBalance(toFacts(row), now);
  const active = row.allocations.filter((a) => a.reversedAt === null && a.payment.status === "RECORDED");
  const lastPaidAt = active.reduce<Date | null>(
    (latest, a) => (latest === null || a.payment.paidAt > latest ? a.payment.paidAt : latest),
    null,
  );

  let state: ObligationLifecycleState = "OPEN";
  let metAt: Date | null = null;
  let settlementAssertedBy: ObligationRecord["settlementAssertedBy"] = null;
  let releasedAt: Date | null = null;

  if (row.status === "CANCELLED" || row.commitment.status === "RELEASED") {
    state = "RELEASED";
    releasedAt = row.cancelledAt ?? row.commitment.updatedAt;
  } else if (row.status === "SETTLED_LEGACY") {
    state = "MET";
    metAt = row.legacyMetAt;
    settlementAssertedBy = "OWNER";
  } else if (row.workflow?.handledAt) {
    // Handled: the reminder is closed. Whether it was PAID is in `ledger`.
    state = "MET";
    metAt = row.workflow.handledAt;
    settlementAssertedBy = "OWNER";
  } else if (balance.remainingMinor <= 0 && balance.paidMinor > 0) {
    // Paid through the payables flow: closed by the ledger, not by assertion.
    state = "MET";
    metAt = lastPaidAt;
  } else if (row.commitment.status === "CLOSED") {
    state = "MET";
    metAt = row.commitment.updatedAt;
  }

  return {
    id: row.id,
    businessId: row.businessId,
    obligeeName: row.commitment.payeeNameSnapshot,
    amount: row.scheduledAmount.toString(),
    currency: row.currency,
    dueAt: row.dueAt,
    state,
    source: "MANUAL",
    recurrence: (row.commitment.scheduleKind === "ONE_OFF" ? "NONE" : row.commitment.recurrence) as RecurrenceCadence,
    recurrenceSeriesId: row.commitment.recurrenceSeriesId,
    note: row.commitment.note,
    followUpAt: row.workflow?.followUpAt ?? null,
    settlementAssertedBy,
    metAt,
    releasedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ledger: {
      commitmentId: row.commitment.id,
      installmentId: row.id,
      paid: fromMinorUnits(balance.paidMinor),
      remaining: fromMinorUnits(Math.max(0, balance.remainingMinor)),
    },
  };
}

function activeAllocations(row: Row) {
  return row.allocations.filter((a) => a.reversedAt === null && a.payment.status === "RECORDED");
}

export function createObligationLedgerStore(
  tx: TenantTx,
  options?: { actorUserId?: number | null; now?: () => Date },
): ObligationStore {
  const actorUserId = options?.actorUserId ?? null;
  const now = () => (options?.now ?? (() => new Date()))();
  // Orientation is not financial and already has its own table; reuse it.
  const orientation = createObligationPrismaStore(tx);

  async function load(businessId: number, id: number): Promise<Row> {
    const row = await tx.installment.findFirst({ where: { id, businessId }, include: ROW_INCLUDE });
    if (!row) throw new NotFoundError("Obligation not found");
    return row;
  }

  async function setWorkflow(
    businessId: number,
    installmentId: number,
    data: { followUpAt?: Date | null; handledAt?: Date | null },
  ): Promise<void> {
    await tx.installmentWorkflow.upsert({
      where: { installmentId },
      create: {
        installmentId,
        businessId,
        followUpAt: data.followUpAt ?? null,
        handledAt: data.handledAt ?? null,
        handledByUserId: data.handledAt ? actorUserId : null,
      },
      update: {
        ...(data.followUpAt !== undefined ? { followUpAt: data.followUpAt } : {}),
        ...(data.handledAt !== undefined
          ? { handledAt: data.handledAt, handledByUserId: data.handledAt ? actorUserId : null }
          : {}),
      },
    });
  }

  /** Release: the underlying commitment ceased to exist from this occurrence on. */
  async function release(businessId: number, row: Row): Promise<void> {
    if (activeAllocations(row).length > 0) {
      throw new ConflictError(
        "PAYABLES_CONFLICT",
        "This occurrence already has a payment against it — reverse the payment first, or mark it handled",
      );
    }
    const earlierLive = await tx.installment.count({
      where: {
        businessId,
        commitmentId: row.commitmentId,
        status: { not: "CANCELLED" },
        dueAt: { lt: row.dueAt },
      },
    });
    if (row.commitment.scheduleKind === "ONE_OFF" || earlierLive === 0) {
      // Nothing of it ever took effect: withdraw the whole commitment.
      await cancelInstallmentInTx(tx, { businessId, installmentId: row.id, actorUserId, reason: "released by the owner" });
      await tx.commitment.update({ where: { id: row.commitmentId }, data: { status: "RELEASED" } });
      await writeAudit(tx, {
        businessId,
        actorUserId,
        commitmentId: row.commitmentId,
        eventType: "COMMITMENT_RELEASED",
        summary: `Commitment "${row.commitment.title}" released from the secretary`,
        metadata: { installmentId: row.id },
      });
      return;
    }
    // It ran until now: it ends the day before this occurrence. History stays.
    const endsOn = new Date(civilDayStart(row.dueAt).getTime() - MS_PER_DAY);
    await endCommitmentInTx(tx, { businessId, commitmentId: row.commitmentId, endsOn, actorUserId });
  }

  async function editOccurrence(businessId: number, row: Row, patch: ObligationPatch): Promise<void> {
    const money = patch.amount !== undefined || patch.dueAt !== undefined || patch.currency !== undefined;
    if (money && activeAllocations(row).length > 0) {
      throw new ConflictError(
        "PAYABLES_CONFLICT",
        "This occurrence already has a payment against it — its amount and date can no longer change",
      );
    }
    const siblings = await tx.installment.findMany({
      where: { businessId, commitmentId: row.commitmentId },
      select: { id: true, dueAt: true, status: true },
      orderBy: { sequence: "asc" },
    });
    const kind = row.commitment.scheduleKind;

    if (patch.amount !== undefined && kind === "INSTALLMENT_PLAN") {
      throw new ValidationError("A payment plan's amounts are fixed by its total — change it on the payables screen");
    }
    if (patch.currency !== undefined && patch.currency !== row.currency && siblings.length > 1) {
      throw new ValidationError("A commitment with several occurrences cannot change currency");
    }
    if (patch.dueAt !== undefined) {
      const newDue = civilDayStart(patch.dueAt).getTime();
      const idx = siblings.findIndex((s) => s.id === row.id);
      const prev = siblings.slice(0, idx).filter((s) => s.status !== "CANCELLED").pop();
      const next = siblings.slice(idx + 1).find((s) => s.status !== "CANCELLED");
      if ((prev && newDue <= civilDayStart(prev.dueAt).getTime()) || (next && newDue >= civilDayStart(next.dueAt).getTime())) {
        throw new ValidationError("The new date would pass another occurrence of the same commitment");
      }
    }

    const installmentData: Prisma.InstallmentUpdateInput = {};
    if (patch.amount !== undefined) {
      const minor = toMinorUnits(patch.amount);
      if (minor <= 0) throw new ValidationError("amount must be positive");
      installmentData.scheduledAmount = new Prisma.Decimal(fromMinorUnits(minor));
    }
    if (patch.dueAt !== undefined) installmentData.dueAt = patch.dueAt;
    if (patch.currency !== undefined) installmentData.currency = patch.currency;
    if (Object.keys(installmentData).length > 0) {
      await tx.installment.update({ where: { id: row.id }, data: installmentData });
    }

    const commitmentData: Prisma.CommitmentUpdateInput = {};
    if (patch.currency !== undefined) commitmentData.currency = patch.currency;
    // A one-off's total IS its single installment (finite-plan invariant).
    if (kind === "ONE_OFF" && installmentData.scheduledAmount) {
      commitmentData.totalAmount = installmentData.scheduledAmount as Prisma.Decimal;
    }
    if (patch.obligeeName !== undefined && patch.obligeeName !== row.commitment.payeeNameSnapshot) {
      if (row.commitment.payeeId !== null) {
        throw new ValidationError("This commitment names a saved payee — rename it on the payables screen");
      }
      commitmentData.title = patch.obligeeName;
      commitmentData.payeeNameSnapshot = patch.obligeeName;
    }
    if (patch.note !== undefined) commitmentData.note = patch.note;
    if (patch.recurrence !== undefined) {
      const current = kind === "ONE_OFF" ? "NONE" : row.commitment.recurrence;
      if (patch.recurrence !== current) {
        if (siblings.length > 1 || kind === "INSTALLMENT_PLAN") {
          throw new ValidationError(
            "A commitment that already has several occurrences cannot change its cadence — end it and start a new one",
          );
        }
        const amount = (installmentData.scheduledAmount as Prisma.Decimal | undefined) ?? row.scheduledAmount;
        if (patch.recurrence === "NONE") {
          commitmentData.scheduleKind = "ONE_OFF";
          commitmentData.recurrence = "NONE";
          commitmentData.totalAmount = amount;
        } else {
          commitmentData.scheduleKind = "RECURRING";
          commitmentData.recurrence = patch.recurrence;
          commitmentData.totalAmount = null;
          commitmentData.recurrenceSeriesId = row.commitment.recurrenceSeriesId ?? globalThis.crypto.randomUUID();
        }
      }
    }
    if (Object.keys(commitmentData).length > 0) {
      await tx.commitment.update({ where: { id: row.commitmentId }, data: commitmentData });
    }
    if (Object.keys(installmentData).length > 0 || Object.keys(commitmentData).length > 0) {
      await writeAudit(tx, {
        businessId,
        actorUserId,
        commitmentId: row.commitmentId,
        installmentId: row.id,
        eventType: "COMMITMENT_UPDATED",
        summary: `Occurrence #${row.sequence} edited from the secretary`,
        metadata: {
          changed: [...Object.keys(installmentData), ...Object.keys(commitmentData)].sort(),
          amountBefore: row.scheduledAmount.toString(),
          dueAtBefore: row.dueAt.toISOString(),
        },
      });
    }
  }

  return {
    async createObligation(row: CreateObligationRow): Promise<ObligationRecord> {
      return translate(async () => {
        if (row.state !== "OPEN") throw new ValidationError("A new obligation starts OPEN");
        const recurring = row.recurrence !== "NONE";
        const commitment = await createCommitmentInTx(tx, {
          businessId: row.businessId,
          actorUserId,
          title: row.obligeeName,
          payeeNameSnapshot: row.obligeeName,
          currency: row.currency,
          scheduleKind: recurring ? "RECURRING" : "ONE_OFF",
          totalAmount: recurring ? null : row.amount,
          recurringAmount: recurring ? row.amount : null,
          recurrence: row.recurrence as RecurrenceCadenceValue,
          firstDueAt: row.dueAt,
          note: row.note,
          recurrenceSeriesId: recurring ? row.recurrenceSeriesId : null,
        });
        const installment = await tx.installment.findFirstOrThrow({
          where: { businessId: row.businessId, commitmentId: commitment.id, sequence: 1 },
        });
        if (row.followUpAt) await setWorkflow(row.businessId, installment.id, { followUpAt: row.followUpAt });
        return toObligationRecord(await load(row.businessId, installment.id), now());
      });
    },

    async updateObligation(businessId: number, id: number, patch: ObligationPatch): Promise<ObligationRecord> {
      return translate(async () => {
        const row = await load(businessId, id);
        if (patch.state === "MET") {
          // "טופל" — closes the reminder. NOT a payment (handled ≠ paid).
          await setWorkflow(businessId, id, { handledAt: patch.metAt ?? now(), followUpAt: null });
        } else if (patch.state === "RELEASED") {
          await release(businessId, row);
          await setWorkflow(businessId, id, { followUpAt: null });
        } else if (patch.state === "OPEN") {
          throw new ValidationError("A closed obligation cannot be reopened here");
        } else {
          const { followUpAt, ...rest } = patch;
          await editOccurrence(businessId, row, rest);
          if (followUpAt !== undefined) await setWorkflow(businessId, id, { followUpAt });
        }
        return toObligationRecord(await load(businessId, id), now());
      });
    },

    async findObligationById(businessId: number, id: number): Promise<ObligationRecord | null> {
      const row = await tx.installment.findFirst({ where: { id, businessId }, include: ROW_INCLUDE });
      return row ? toObligationRecord(row, now()) : null;
    },

    async listObligations(businessId: number, options?: ListObligationsOptions): Promise<ObligationRecord[]> {
      const rows = await tx.installment.findMany({
        where: { businessId },
        include: ROW_INCLUDE,
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      });
      const at = now();
      let records = rows.map((r) => ({ row: r, record: toObligationRecord(r, at) }));
      const states = options?.states;
      if (states && states.length > 0) records = records.filter((x) => states.includes(x.record.state));
      // The secretary shows ONE open occurrence per commitment — the next one
      // owed — exactly as the legacy store held one OPEN row per series.
      if (states && states.length === 1 && states[0] === "OPEN") {
        const seen = new Set<number>();
        records = records.filter((x) => {
          if (seen.has(x.row.commitmentId)) return false;
          seen.add(x.row.commitmentId);
          return true;
        });
      }
      return records.slice(0, options?.limit ?? 500).map((x) => x.record);
    },

    getOrientation: (businessId) => orientation.getOrientation(businessId),
    setOriented: (businessId, orientedAt) => orientation.setOriented(businessId, orientedAt),

    async continueSeries(businessId: number, id: number): Promise<ObligationRecord | null> {
      return translate(async () => {
        const row = await load(businessId, id);
        // An occurrence after this one may already exist — settling it through
        // the payment flow materialises the next, and a plan pre-creates all.
        const existing = await tx.installment.findFirst({
          where: { businessId, commitmentId: row.commitmentId, sequence: { gt: row.sequence }, status: "SCHEDULED" },
          orderBy: { sequence: "asc" },
          select: { id: true },
        });
        if (existing) return toObligationRecord(await load(businessId, existing.id), now());
        if (row.commitment.scheduleKind !== "RECURRING") return null;
        const next = await materialiseNextRecurringInstallmentInTx(tx, {
          businessId,
          commitmentId: row.commitmentId,
          actorUserId,
        });
        return next ? toObligationRecord(await load(businessId, next.id), now()) : null;
      });
    },
  };
}
