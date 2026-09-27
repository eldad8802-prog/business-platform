/**
 * Payables — the read side.
 *
 * Kept apart from `payables.service.ts` deliberately. That module changes the
 * ledger and answers for every invariant while doing so; this one only asks it
 * questions. Nothing here writes, and nothing here is allowed to compute money
 * on its own: every figure comes from `payables-core`, so the screen and the
 * service can never disagree about what is paid.
 *
 * There are, as ever, NO cached balances. A list of fifty commitments derives
 * fifty rollups from their allocations, because the alternative is a stored
 * total that drifts the moment an allocation is reversed.
 */

import type { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  deriveCommitmentBalance,
  deriveInstallmentBalance,
  fromMinorUnits,
  PayablesNotFoundError,
  toMinorUnits,
  sumActiveAllocations,
  type CommitmentScheduleKindValue,
  type DerivedInstallmentState,
  type InstallmentFacts,
} from "./payables-core";

export { PayablesNotFoundError } from "./payables-core";

/** The same shape `payables.service` builds, so both derive from identical facts. */
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
 * How loudly a commitment should ask for attention.
 *
 * This is a PRESENTATION order, not an accounting fact, which is why it lives
 * on the read side. Overdue money first, then what is due, then everything
 * already settled — and a legacy assertion sorts with the settled, because the
 * owner already told us they handled it and must not be nagged again.
 */
const ATTENTION_RANK: Record<DerivedInstallmentState, number> = {
  OVERDUE: 0,
  DUE: 1,
  PARTIALLY_PAID: 2,
  SCHEDULED: 3,
  PAID: 4,
  SETTLED_LEGACY: 5,
  CANCELLED: 6,
};

export type CommitmentListRow = {
  id: number;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  currency: string;
  scheduleKind: CommitmentScheduleKindValue;
  status: string;
  /** null for RECURRING — an open-ended commitment has no total to state. */
  total: string | null;
  paid: string;
  /** null for RECURRING — deliberately NOT invented. */
  remaining: string | null;
  installmentCount: number;
  /** The installment the owner should look at next, if any remains open. */
  next: {
    id: number;
    sequence: number;
    dueAt: Date;
    scheduled: string;
    remaining: string;
    state: DerivedInstallmentState;
  } | null;
  /** Drives the badge, and the order of the list. */
  attention: DerivedInstallmentState;
  isLegacy: boolean;
};

const LIST_INCLUDE = {
  installments: {
    orderBy: { sequence: "asc" },
    include: {
      allocations: { include: { payment: { select: { status: true } } } },
    },
  },
} satisfies Prisma.CommitmentInclude;

export async function listCommitments(input: {
  businessId: number;
  /** "open" hides commitments that have nothing left to do. */
  scope?: "open" | "all";
  now?: Date;
}): Promise<CommitmentListRow[]> {
  const now = input.now ?? new Date();
  const scope = input.scope ?? "open";

  return withTenantTransaction(async (tx) => {
    const commitments = await tx.commitment.findMany({
      where: {
        businessId: input.businessId,
        ...(scope === "open" ? { status: { in: ["ACTIVE"] } } : {}),
      },
      include: LIST_INCLUDE,
      orderBy: { id: "desc" },
    });

    const rows = commitments.map((commitment): CommitmentListRow => {
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

      const derived = commitment.installments.map((row, i) => ({
        row,
        balance: deriveInstallmentBalance(facts[i], now),
      }));

      // "Next" means the earliest instalment that still wants something. A
      // cancelled or legacy-settled one wants nothing and is skipped.
      const open = derived
        .filter((d) => d.balance.remainingMinor > 0 && d.balance.state !== "CANCELLED")
        .sort((a, b) => a.row.dueAt.getTime() - b.row.dueAt.getTime());
      const next = open[0] ?? null;

      const attention = derived.reduce<DerivedInstallmentState>((worst, d) => {
        return ATTENTION_RANK[d.balance.state] < ATTENTION_RANK[worst]
          ? d.balance.state
          : worst;
      }, "CANCELLED");

      return {
        id: commitment.id,
        title: commitment.title,
        payeeId: commitment.payeeId,
        payeeNameSnapshot: commitment.payeeNameSnapshot,
        currency: commitment.currency,
        scheduleKind: commitment.scheduleKind as CommitmentScheduleKindValue,
        status: commitment.status,
        total: rollup.totalMinor === null ? null : fromMinorUnits(rollup.totalMinor),
        paid: fromMinorUnits(rollup.paidMinor),
        remaining:
          rollup.remainingMinor === null ? null : fromMinorUnits(rollup.remainingMinor),
        installmentCount: commitment.installments.length,
        next: next
          ? {
              id: next.row.id,
              sequence: next.row.sequence,
              dueAt: next.row.dueAt,
              scheduled: fromMinorUnits(next.balance.scheduledMinor),
              remaining: fromMinorUnits(next.balance.remainingMinor),
              state: next.balance.state,
            }
          : null,
        attention,
        isLegacy: commitment.legacyObligationId !== null,
      };
    });

    return rows.sort((a, b) => {
      const byAttention = ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention];
      if (byAttention !== 0) return byAttention;
      const aDue = a.next?.dueAt.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bDue = b.next?.dueAt.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aDue - bDue;
    });
  });
}

export type CommitmentDetail = {
  id: number;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  currency: string;
  scheduleKind: CommitmentScheduleKindValue;
  recurrence: string;
  status: string;
  /** Last day in effect (inclusive), when the commitment was ended. */
  endAt: Date | null;
  note: string | null;
  total: string | null;
  paid: string;
  remaining: string | null;
  isLegacy: boolean;
  /** Present only for a migrated row, and never presented as a payment. */
  legacy: { assertedBy: string | null; metAt: Date | null } | null;
  installments: Array<{
    id: number;
    sequence: number;
    dueAt: Date;
    scheduled: string;
    paid: string;
    remaining: string;
    state: DerivedInstallmentState;
    status: string;
    legacyAssertedBy: string | null;
    legacyMetAt: Date | null;
    allocations: Array<{
      id: number;
      paymentId: number;
      amount: string;
      active: boolean;
      reversedAt: Date | null;
      reversalReason: string | null;
      paymentStatus: string;
      paymentPaidAt: Date;
      paymentMethod: string;
    }>;
  }>;
  /** Every payment that touches this commitment, with what is still unapplied. */
  payments: Array<{
    id: number;
    amount: string;
    allocated: string;
    unallocated: string;
    status: string;
    method: string;
    paidAt: Date;
    externalReference: string | null;
  }>;
  audit: Array<{
    id: number;
    eventType: string;
    source: string;
    summary: string | null;
    occurredAt: Date;
  }>;
};

export async function getCommitmentDetail(input: {
  businessId: number;
  commitmentId: number;
  now?: Date;
}): Promise<CommitmentDetail> {
  const now = input.now ?? new Date();

  return withTenantTransaction(async (tx) => {
    const commitment = await tx.commitment.findFirst({
      where: { id: input.commitmentId, businessId: input.businessId },
      include: {
        installments: {
          orderBy: { sequence: "asc" },
          include: {
            allocations: {
              orderBy: { id: "asc" },
              include: {
                payment: {
                  select: {
                    id: true,
                    status: true,
                    paidAt: true,
                    method: true,
                    amount: true,
                    externalReference: true,
                  },
                },
              },
            },
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

    // One row per payment, not per allocation: a single payment spread over
    // four instalments is ONE economic event and must be presented as one.
    const payments = new Map<number, CommitmentDetail["payments"][number]>();
    for (const installment of commitment.installments) {
      for (const allocation of installment.allocations) {
        const p = allocation.payment;
        if (!payments.has(p.id)) {
          payments.set(p.id, {
            id: p.id,
            amount: p.amount.toString(),
            allocated: "0.00",
            unallocated: p.amount.toString(),
            status: p.status,
            method: p.method,
            paidAt: p.paidAt,
            externalReference: p.externalReference,
          });
        }
      }
    }

    // What a payment has actually applied is the sum of its ACTIVE allocations
    // — across every instalment, including ones outside this commitment, so the
    // surplus shown is the real surplus and not a local illusion.
    for (const [paymentId, row] of payments) {
      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId, businessId: input.businessId },
        select: {
          allocatedAmount: true,
          reversedAt: true,
          payment: { select: { status: true } },
        },
      });
      const allocatedMinor = sumActiveAllocations(
        allocations.map((a) => ({
          allocatedAmountMinor: toMinorUnits(a.allocatedAmount.toString()),
          reversedAt: a.reversedAt,
          payment: { status: a.payment.status as "RECORDED" | "VOID" },
        })),
      );
      const amountMinor = toMinorUnits(row.amount);
      row.allocated = fromMinorUnits(allocatedMinor);
      row.unallocated = fromMinorUnits(Math.max(0, amountMinor - allocatedMinor));
    }

    const audit = await tx.payablesAuditEvent.findMany({
      where: { businessId: input.businessId, commitmentId: commitment.id },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: {
        id: true,
        eventType: true,
        source: true,
        summary: true,
        occurredAt: true,
      },
    });

    const legacyInstallment = commitment.installments.find(
      (i) => i.legacySettlementAssertedBy !== null || i.legacyMetAt !== null,
    );

    return {
      id: commitment.id,
      title: commitment.title,
      payeeId: commitment.payeeId,
      payeeNameSnapshot: commitment.payeeNameSnapshot,
      currency: commitment.currency,
      scheduleKind: commitment.scheduleKind as CommitmentScheduleKindValue,
      recurrence: commitment.recurrence,
      status: commitment.status,
      endAt: commitment.endAt,
      note: commitment.note,
      total: rollup.totalMinor === null ? null : fromMinorUnits(rollup.totalMinor),
      paid: fromMinorUnits(rollup.paidMinor),
      remaining:
        rollup.remainingMinor === null ? null : fromMinorUnits(rollup.remainingMinor),
      isLegacy: commitment.legacyObligationId !== null,
      legacy: legacyInstallment
        ? {
            assertedBy: legacyInstallment.legacySettlementAssertedBy,
            metAt: legacyInstallment.legacyMetAt,
          }
        : null,
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
          status: row.status,
          legacyAssertedBy: row.legacySettlementAssertedBy,
          legacyMetAt: row.legacyMetAt,
          allocations: row.allocations.map((a) => ({
            id: a.id,
            paymentId: a.paymentId,
            amount: a.allocatedAmount.toString(),
            active: a.reversedAt === null && a.payment.status === "RECORDED",
            reversedAt: a.reversedAt,
            reversalReason: a.reversalReason,
            paymentStatus: a.payment.status,
            paymentPaidAt: a.payment.paidAt,
            paymentMethod: a.payment.method,
          })),
        };
      }),
      payments: [...payments.values()].sort(
        (a, b) => b.paidAt.getTime() - a.paidAt.getTime(),
      ),
      audit,
    };
  });
}
