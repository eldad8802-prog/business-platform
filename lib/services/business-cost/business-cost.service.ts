/**
 * Daily Business Cost — the read side.
 *
 * Loads the authoritative rows for ONE business inside ONE tenant transaction
 * and hands plain values to `business-cost-core`, which makes every decision.
 * Nothing here writes, nothing here computes money, and nothing is cached: the
 * answer is re-derived from the ledger on every call, so it can never drift
 * from it.
 *
 * Sources, and only these:
 *   Commitment + Installment + Payee.kind   what is owed, per occurrence
 *   BusinessObligation (not yet backfilled) what the secretary recorded after
 *                                           the one-time backfill — see below
 *   Payment + active PaymentAllocation      what actually left the business
 *   BusinessObligationOrientation           whether the owner affirmed the
 *                                           recurring backbone is captured
 *
 * ── Why BusinessObligation is read at all ────────────────────────────────────
 * The payables programme declares it legacy, but `/secretary` and Home still
 * write it and nothing dual-writes into `Commitment`; the backfill
 * (20260917090200) ran once. Reading only the ledger would silently drop every
 * obligation the owner recorded since. So rows WITHOUT a Commitment
 * (`legacyObligationId`) are mapped with the backfill's own §13 rules, marked
 * `LEGACY_OBLIGATION` on every line, and never mixed into the ledger. A row that
 * HAS a Commitment is read only from the ledger — never twice. This bridge
 * disappears on its own once the secretary writes Commitments.
 *
 * Tenant isolation: every query is inside `tenantTx` (sets
 * `app.current_business_id`, which RLS on all six tables enforces) AND filters
 * by `businessId` explicitly, the belt-and-braces pattern of the payables
 * service. `businessId` comes from the caller's session, never a request body.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { fromMinorUnits, toMinorUnits } from "@/lib/services/payables/payables-core";
import {
  civilDateInZone,
  DEFAULT_BUSINESS_TIME_ZONE,
  deriveBusinessCostForDate,
  explainLineHe,
  toDayNumber,
  type BusinessCostDay,
  type CostCommitment,
  type CostLine,
  type CostPayment,
  type PayeeKind,
} from "./business-cost-core";

const BASE_CURRENCY = "ILS";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function deriveBusinessCost(input: {
  businessId: number;
  /** Civil date "YYYY-MM-DD" in the business time zone. Default: today there. */
  date?: string | null;
  now?: Date;
}): Promise<BusinessCostDay> {
  // There is no per-business time zone column; every Dubiz business today is
  // in Israel. When one is added it is read here and nowhere else.
  const timeZone = DEFAULT_BUSINESS_TIME_ZONE;
  const date = input.date ?? civilDateInZone(input.now ?? new Date(), timeZone);
  const day = toDayNumber(date); // validates before any query runs

  // Any instant whose local date is `date` lies within ±1 day of its UTC
  // midnight (Israel is UTC+2/+3). Two days either side is a safe superset;
  // the core then selects by exact local date.
  const paidFrom = new Date((day - 2) * MS_PER_DAY);
  const paidTo = new Date((day + 3) * MS_PER_DAY);

  const { businessId } = input;

  const facts = await tenantTx(businessId, async (tx) => {
    const commitments = await tx.commitment.findMany({
      where: { businessId },
      select: {
        id: true,
        title: true,
        payeeNameSnapshot: true,
        currency: true,
        scheduleKind: true,
        recurrence: true,
        recurrenceSeriesId: true,
        status: true,
        legacyObligationId: true,
        endAt: true,
        payee: { select: { kind: true } },
        installments: {
          where: { businessId },
          select: {
            id: true,
            sequence: true,
            dueAt: true,
            scheduledAmount: true,
            currency: true,
            status: true,
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { id: "asc" },
    });

    const obligations = await tx.businessObligation.findMany({
      where: { businessId },
      select: {
        id: true,
        obligeeName: true,
        amount: true,
        currency: true,
        dueAt: true,
        state: true,
        recurrence: true,
        recurrenceSeriesId: true,
      },
      orderBy: { id: "asc" },
    });

    const payments = await tx.payment.findMany({
      where: { businessId, paidAt: { gte: paidFrom, lt: paidTo } },
      select: {
        id: true,
        paidAt: true,
        amount: true,
        currency: true,
        status: true,
        payeeNameSnapshot: true,
        method: true,
        allocations: {
          // The frozen active predicate, first half; the payment's own status
          // is the second half and is checked by the core.
          where: { businessId, reversedAt: null },
          select: {
            installmentId: true,
            allocatedAmount: true,
            installment: { select: { commitmentId: true } },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    const orientation = await tx.businessObligationOrientation.findFirst({
      where: { businessId },
      select: { oriented: true },
    });

    return { commitments, obligations, payments, orientation };
  });

  const backfilled = new Set(
    facts.commitments.map((c) => c.legacyObligationId).filter((id): id is number => id !== null),
  );

  const fromLedger: CostCommitment[] = facts.commitments.map((c) => ({
    source: "COMMITMENT",
    id: c.id,
    title: c.title,
    payeeName: c.payeeNameSnapshot,
    payeeKind: (c.payee?.kind ?? null) as PayeeKind | null,
    currency: c.currency,
    scheduleKind: c.scheduleKind,
    recurrence: c.recurrence,
    recurrenceSeriesId: c.recurrenceSeriesId,
    status: c.status,
    isLegacy: c.legacyObligationId !== null,
    endDate: c.endAt ? civilDateInZone(c.endAt, timeZone) : null,
    installments: c.installments.map((i) => ({
      id: i.id,
      sequence: i.sequence,
      dueDate: civilDateInZone(i.dueAt, timeZone),
      amountMinor: toMinorUnits(i.scheduledAmount.toString()),
      currency: i.currency,
      status: i.status,
    })),
  }));

  // The backfill's mapping, verbatim (migration 20260917090200 / programme §13).
  const fromSecretary: CostCommitment[] = facts.obligations
    .filter((o) => !backfilled.has(o.id))
    .map((o) => ({
      source: "LEGACY_OBLIGATION",
      id: o.id,
      title: o.obligeeName,
      payeeName: o.obligeeName,
      payeeKind: null,
      currency: o.currency,
      scheduleKind: o.recurrence === "NONE" ? "ONE_OFF" : "RECURRING",
      recurrence: o.recurrence,
      recurrenceSeriesId: o.recurrenceSeriesId,
      status: o.state === "MET" ? "CLOSED" : o.state === "RELEASED" ? "RELEASED" : "ACTIVE",
      isLegacy: true,
      endDate: null,
      installments: [
        {
          id: o.id,
          sequence: 1,
          dueDate: civilDateInZone(o.dueAt, timeZone),
          amountMinor: toMinorUnits(o.amount.toString()),
          currency: o.currency,
          status: o.state === "MET" ? "SETTLED_LEGACY" : "SCHEDULED",
        },
      ],
    }));

  const payments: CostPayment[] = facts.payments.map((p) => ({
    id: p.id,
    paidAt: p.paidAt,
    amountMinor: toMinorUnits(p.amount.toString()),
    currency: p.currency,
    status: p.status,
    payeeName: p.payeeNameSnapshot,
    method: p.method,
    allocations: p.allocations.map((a) => ({
      installmentId: a.installmentId,
      commitmentId: a.installment.commitmentId,
      amountMinor: toMinorUnits(a.allocatedAmount.toString()),
    })),
  }));

  return deriveBusinessCostForDate({
    date,
    timeZone,
    baseCurrency: BASE_CURRENCY,
    commitments: [...fromLedger, ...fromSecretary],
    payments,
    ownerAffirmedBackboneCaptured: facts.orientation ? facts.orientation.oriented : null,
  });
}

/* ──────────────────────────────── serialisation ──────────────────────────── */

function money(minor: number): string {
  return fromMinorUnits(minor);
}

function serializeLine(line: CostLine) {
  return {
    source: line.source,
    commitmentId: line.commitmentId,
    installmentId: line.installmentId,
    title: line.title,
    payeeName: line.payeeName,
    nature: line.nature,
    recurrence: line.recurrence,
    basis: line.basis,
    period: line.period,
    periodAmount: money(line.periodAmountMinor),
    allocated: money(line.allocatedMinor),
    baselineDaily: money(line.baselineDailyMinor),
    occurrencesProjected: line.occurrencesProjected,
    explanation: explainLineHe(line),
  };
}

/** The API shape: decimal strings, never floats; every line carries its sentence. */
export function serializeBusinessCostDay(day: BusinessCostDay) {
  return {
    date: day.date,
    timeZone: day.timeZone,
    currency: day.currency,
    allocatedCost: {
      total: money(day.allocatedCost.totalMinor),
      recorded: money(day.allocatedCost.recordedMinor),
      projected: money(day.allocatedCost.projectedMinor),
      lines: day.allocatedCost.lines.map(serializeLine),
    },
    baselineDailyCost: { total: money(day.baselineDailyCost.totalMinor) },
    debtService: {
      allocated: money(day.debtService.allocatedMinor),
      baselineDaily: money(day.debtService.baselineDailyMinor),
      lines: day.debtService.lines.map(serializeLine),
    },
    cashOut: {
      total: money(day.cashOut.totalMinor),
      payments: day.cashOut.payments.map((p) => ({
        paymentId: p.paymentId,
        amount: money(p.amountMinor),
        payeeName: p.payeeName,
        method: p.method,
        unallocated: money(p.unallocatedMinor),
        allocations: p.allocations.map((a) => ({
          installmentId: a.installmentId,
          commitmentId: a.commitmentId,
          amount: money(a.amountMinor),
        })),
      })),
      otherCurrency: day.cashOut.otherCurrency.map((p) => ({
        paymentId: p.paymentId,
        amount: money(p.amountMinor),
        currency: p.currency,
      })),
    },
    uncertain: {
      window: day.uncertain.window,
      total: money(day.uncertain.totalMinor),
      items: day.uncertain.items.map(({ amountMinor, ...rest }) => ({ ...rest, amount: money(amountMinor) })),
    },
    excluded: day.excluded,
    completeness: day.completeness,
  };
}
