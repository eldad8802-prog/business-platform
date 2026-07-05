/**
 * Collection Workspace read-model — the single source of truth for the main
 * collection screen. Pure over the PaymentStore port (business-scoped),
 * derives every state/bucket from objective data only.
 *
 * v1 scope (locked): CardCom-verified collections. Two truth states
 * (waiting · verified) + honest lifecycle labels (failed / expired / cancelled).
 * NO partial, NO aging/overdue, NO Billing per-invoice settlement, NO
 * multi-channel. "expired" is derived from expiresAt; "collected this month"
 * counts only PAID (verified) — Authority Principle preserved.
 */

import type { PaymentRequestRecord, PaymentStore } from "./payments.types";
import {
  deriveCollectionView,
  HISTORY_STATUSES,
  WORKING_STATUSES,
  type CollectionViewState,
} from "./collection-view";

export interface CollectionItemView {
  id: number;
  description: string | null;
  amount: string;
  currency: string;
  state: CollectionViewState;
  provider: string;
  paymentUrl: string | null;
  createdAt: string;
  paidAt: string | null;
  expiresAt: string | null;
}

export interface CollectionMoneyFigure {
  amount: string;
  count: number;
}

export interface CollectionSummary {
  /** Open + waiting (PENDING, not expired). */
  pending: CollectionMoneyFigure;
  /** Verified (PAID) with paidAt in the current month. */
  collectedThisMonth: CollectionMoneyFigure;
  /** Objective expired (link lifetime passed) — needs a decision. */
  expired: CollectionMoneyFigure;
}

export interface CollectionWorkspaceResult {
  summary: CollectionSummary;
  /** Needs action: failed + expired. */
  attention: CollectionItemView[];
  /** Live work: waiting. */
  active: CollectionItemView[];
  /** Closed: verified + cancelled, newest-first, read-only. */
  history: CollectionItemView[];
}

function toItem(
  record: PaymentRequestRecord,
  state: CollectionViewState
): CollectionItemView {
  return {
    id: record.id,
    description: record.description,
    amount: record.amount,
    currency: record.currency,
    state,
    provider: record.provider,
    paymentUrl: record.paymentUrl,
    createdAt: record.createdAt.toISOString(),
    paidAt: record.paidAt ? record.paidAt.toISOString() : null,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
  };
}

function money(sum: number): string {
  return (Math.round(sum * 100) / 100).toFixed(2);
}

/** First instant of `now`'s calendar month, and first instant of the next. */
function monthBounds(now: Date): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { from, to };
}

export interface GetCollectionWorkspaceOptions {
  businessId: number;
  now: Date;
  /** History page size (closed collections). */
  historyLimit?: number;
}

export async function getCollectionWorkspace(
  store: PaymentStore,
  { businessId, now, historyLimit = 50 }: GetCollectionWorkspaceOptions
): Promise<CollectionWorkspaceResult> {
  // 1. Open working set (open + failed + persisted-expired) — bucket is derived,
  //    never assumed from the query.
  const working = await store.listPaymentRequestsByStatuses(businessId, [
    ...WORKING_STATUSES,
  ]);

  const attention: CollectionItemView[] = [];
  const active: CollectionItemView[] = [];
  let pendingSum = 0;
  let pendingCount = 0;
  let expiredSum = 0;
  let expiredCount = 0;

  for (const r of working) {
    const view = deriveCollectionView(r, now);
    const item = toItem(r, view.state);
    if (view.bucket === "active") {
      active.push(item);
      pendingSum += Number(r.amount);
      pendingCount += 1;
    } else if (view.bucket === "attention") {
      attention.push(item);
      if (view.state === "expired") {
        expiredSum += Number(r.amount);
        expiredCount += 1;
      }
    }
  }

  // 2. Collected this month — verified (PAID) only, DB-aggregated by paidAt.
  const { from, to } = monthBounds(now);
  const collected = await store.sumPaidBetween(businessId, from, to);

  // 3. History — closed (verified + cancelled), newest-first, capped.
  const historyRows = await store.listPaymentRequestsByStatuses(
    businessId,
    [...HISTORY_STATUSES],
    { limit: historyLimit }
  );
  const history = historyRows.map((r) =>
    toItem(r, deriveCollectionView(r, now).state)
  );

  return {
    summary: {
      pending: { amount: money(pendingSum), count: pendingCount },
      collectedThisMonth: {
        amount: collected.amount,
        count: collected.count,
      },
      expired: { amount: money(expiredSum), count: expiredCount },
    },
    attention,
    active,
    history,
  };
}
