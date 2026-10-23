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

import { BASE_CURRENCY, currencyOrBase, orderCurrencies } from "@/lib/money/currency-split";

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

export interface CollectionCurrencyTotal {
  currency: string;
  amount: string;
  count: number;
}

/**
 * One summary figure. Amounts in different currencies are never added: `amount` is the ILS rows
 * only (the screen draws it as ₪), `count` is every row, and the other currencies are listed in
 * `totalsByCurrency` with `isMixedCurrency` set. For an all-ILS business `amount` / `count` are
 * the same values as before.
 */
export interface CollectionMoneyFigure {
  amount: string;
  count: number;
  /** The currency of `amount`: always ILS. */
  currency: string;
  /** ILS first, then the rest by code; only currencies that occurred. */
  totalsByCurrency: CollectionCurrencyTotal[];
  /** True when another currency occurred — `amount` does not include it. */
  isMixedCurrency: boolean;
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

type CurrencySums = Map<string, { sum: number; count: number }>;

/** Adds a request into its OWN currency's running sum (the same float arithmetic as before). */
function addInCurrency(sums: CurrencySums, record: PaymentRequestRecord): void {
  const currency = currencyOrBase(record.currency);
  const entry = sums.get(currency) ?? { sum: 0, count: 0 };
  sums.set(currency, { sum: entry.sum + Number(record.amount), count: entry.count + 1 });
}

function figureOf(sums: CurrencySums, count: number): CollectionMoneyFigure {
  const totalsByCurrency = orderCurrencies(sums.keys(), BASE_CURRENCY).map((currency) => ({
    currency,
    amount: money(sums.get(currency)!.sum),
    count: sums.get(currency)!.count,
  }));
  return {
    amount: money(sums.get(BASE_CURRENCY)?.sum ?? 0),
    count,
    currency: BASE_CURRENCY,
    totalsByCurrency,
    isMixedCurrency: totalsByCurrency.some((t) => t.currency !== BASE_CURRENCY),
  };
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
  const pendingSums: CurrencySums = new Map();
  let pendingCount = 0;
  const expiredSums: CurrencySums = new Map();
  let expiredCount = 0;

  for (const r of working) {
    const view = deriveCollectionView(r, now);
    const item = toItem(r, view.state);
    if (view.bucket === "active") {
      active.push(item);
      addInCurrency(pendingSums, r);
      pendingCount += 1;
    } else if (view.bucket === "attention") {
      attention.push(item);
      if (view.state === "expired") {
        addInCurrency(expiredSums, r);
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
      pending: figureOf(pendingSums, pendingCount),
      collectedThisMonth: {
        amount: collected.amount,
        count: collected.count,
        currency: BASE_CURRENCY,
        totalsByCurrency: collected.byCurrency,
        isMixedCurrency: collected.byCurrency.some((t) => t.currency !== BASE_CURRENCY),
      },
      expired: figureOf(expiredSums, expiredCount),
    },
    attention,
    active,
    history,
  };
}
