/**
 * M4 · Reconciliation — making knowledge stop being authoritative when its evidence moves on.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The writer replaces a slot. That is enough while a rule keeps producing the same subjects, and
 * silently wrong the moment it does not. Two cases, both ordinary:
 *
 *   A SUPPLIER GOES QUIET. Last month the cadence rule wrote a measure for supplier 7. This month
 *   supplier 7 has no orders left inside the window, so the rule produces nothing for them — and the
 *   old row survives, untouched, still ACTIVE, still saying "every 14 days" about a relationship that
 *   ended. Nothing failed. Nothing logged. The knowledge simply outlived its evidence.
 *
 *   A RULE CHANGES. A new version writes to a different slot, because the slot key includes the rule
 *   version. The previous version's row stays ACTIVE beside it, and a consumer asking for
 *   `suppliers.delivery_lag` now gets two contradictory answers with no way to prefer one.
 *
 * So after every rule runs, the measures it did NOT produce this time are reconciled:
 *
 *   STALE       produced before, not produced now, same rule version — the subject fell out of the
 *               window, was deleted, or had its evidence reversed
 *   SUPERSEDED  same measure key, a DIFFERENT rule version — replaced rather than expired
 *
 * NOTHING IS DELETED. A stale measure keeps its number, its window and its evidence links, because
 * "we used to believe this, from this evidence, until here" is exactly what an audit needs and what a
 * later outcome-learning layer will want. Only `status` changes, and only ACTIVE is consumable — the
 * composer already refuses everything else, so demoting a row is sufficient to take it out of
 * circulation.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

/** The narrow surface this needs. Injectable so the logic is testable without a database. */
export interface MeasureReconcilerTx {
  knowledgeMeasure: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}
export interface MeasureReconcilerClient {
  $transaction<T>(fn: (tx: MeasureReconcilerTx) => Promise<T>): Promise<T>;
}

function tenantReconcilerClient(businessId: number): MeasureReconcilerClient {
  return {
    $transaction: <T>(fn: (tx: MeasureReconcilerTx) => Promise<T>): Promise<T> =>
      tenantTx(businessId, (tx) => fn(tx as unknown as MeasureReconcilerTx)),
  };
}

export type ReconcileOutcome = {
  readonly staled: number;
  readonly superseded: number;
};

/**
 * Reconcile one rule's output against what is already stored for it.
 *
 * `producedEntityIds` is every subject the rule spoke about this run — `[null]` for a business-level
 * rule, which produces exactly one measure with a null subject. An EMPTY array means the rule
 * produced nothing at all, and every stored measure for it becomes stale; that case is why the
 * argument is a list rather than a filter, because "the rule ran and found nobody" and "the rule did
 * not run" must not look the same.
 */
export async function reconcileRuleMeasures(
  businessId: number,
  measureKey: string,
  currentPolicyVersionId: number,
  producedEntityIds: readonly (number | null)[],
  client: MeasureReconcilerClient = tenantReconcilerClient(businessId),
): Promise<ReconcileOutcome> {
  const produced = producedEntityIds.filter((id): id is number => id != null);
  const producedBusinessLevel = producedEntityIds.some((id) => id == null);

  return client.$transaction(async (tx) => {
    // Any live row under an OLDER (or simply different) version of this rule is not merely out of
    // date — it has been replaced, and SUPERSEDED says so where STALE would not.
    const superseded = await tx.knowledgeMeasure.updateMany({
      where: {
        businessId,
        measureKey,
        rulePolicyVersionId: { not: currentPolicyVersionId },
        status: { in: ["ACTIVE", "INSUFFICIENT_EVIDENCE"] },
      },
      data: { status: "SUPERSEDED" },
    });

    // Under the CURRENT version, anything this run did not speak about has lost its evidence.
    // `entityId notIn []` is not a usable predicate in every client, so the business-level row is
    // handled as its own clause rather than folded into the list.
    const staleWhere: Record<string, unknown> = {
      businessId,
      measureKey,
      rulePolicyVersionId: currentPolicyVersionId,
      status: { in: ["ACTIVE", "INSUFFICIENT_EVIDENCE"] },
      AND: [
        produced.length > 0 ? { NOT: { entityId: { in: produced } } } : {},
        producedBusinessLevel ? { NOT: { entityId: null } } : {},
      ],
    };

    const staled = await tx.knowledgeMeasure.updateMany({
      where: staleWhere,
      data: { status: "STALE" },
    });

    return { staled: staled.count, superseded: superseded.count };
  });
}
