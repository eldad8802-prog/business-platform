"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSupplierPurchaseHistory,
  type SupplierPurchaseHistory,
  type SupplierPurchasedItem,
  type SupplierPurchaseOrderItem,
} from "@/lib/api/suppliers";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import {
  canLoadMore,
  costCoverageNote,
  formatLineCount,
  formatPurchaseDate,
  formatSupplierMoney,
  mergePurchaseOrderItems,
  priceTrend,
  PRICE_TREND_LABEL_KEY,
  statusBadge,
} from "@/lib/inventory/supplier-purchase-history-view";
import { useI18n } from "@/components/i18n/I18nProvider";
import { BagIcon } from "@/components/customers/customer-icons";
import { intlTag } from "@/lib/i18n/config";

const PAGE_SIZE = 10;
/** Orders shown before "show more" — the rest of the loaded page opens in place. */
const PREVIEW_ORDERS = 5;

type Props = {
  supplierId: number;
  /** Current supplier name — used only to decide whether a historical snapshot name is worth showing. */
  supplierName: string;
};

/**
 * Purchase history section for the supplier card (S4-P5). Loads independently from
 * the supplier record and from Notes/Attachments — a failure here never takes down
 * the rest of the card. Data source is the S4-P4 read model via the client wrapper;
 * the UI never queries Prisma or filters by supplier name.
 *
 * Layout (supplier file redesign): one "new order" action, in the head — the
 * empty state is a short line, not a second button. Rows are flat items inside
 * the panel; an order's value sits in the amount slot.
 */
export function SupplierPurchaseHistorySection({ supplierId, supplierName }: Props) {
  const { t, locale } = useI18n();
  const [summary, setSummary] = useState<SupplierPurchaseHistory["summary"] | null>(null);
  const [items, setItems] = useState<SupplierPurchaseOrderItem[]>([]);
  const [purchasedItems, setPurchasedItems] = useState<SupplierPurchasedItem[]>(
    []
  );
  const [pagination, setPagination] = useState<SupplierPurchaseHistory["pagination"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A failed next page — shown under the rows already loaded, never instead of them. */
  const [moreError, setMoreError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Retry re-runs the first-page effect by bumping this key (event-driven setState),
  // which keeps the effect body's own setState calls all post-await.
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // First page loads independently on mount / supplier change. Every setState here
  // runs after an await (or in cleanup-guarded finally), so it never fires
  // synchronously within the effect. `active` drops stale responses.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getSupplierPurchaseHistory(supplierId, {
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (!active) return;
        setError(null);
        setSummary(data.summary);
        setItems(data.items);
        setPurchasedItems(data.purchasedItems ?? []);
        setPagination(data.pagination);
      } catch (err: unknown) {
        if (!active) return;
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        setError(t("customers.suppliers.history.errorLoad"));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [supplierId, reloadKey, t]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const loadMore = useCallback(async () => {
    // Guard against double-clicks: a second click while a page is in flight is a no-op.
    if (loadingMoreRef.current || !pagination?.hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const nextOffset = pagination.offset + pagination.limit;
      const data = await getSupplierPurchaseHistory(supplierId, {
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      setItems((prev) => mergePurchaseOrderItems(prev, data.items));
      setPagination(data.pagination);
      if (data.summary) setSummary(data.summary);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      // A failed "load more" keeps the already-loaded rows and the rest of the card:
      // it has its OWN state. Setting the section-level `error` here used to replace
      // every loaded row with an error panel, and its retry restarted from page one.
      setMoreError(t("customers.suppliers.history.errorLoadMore"));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [supplierId, pagination, t]);

  const total = summary?.purchaseOrderCount ?? pagination?.total ?? 0;

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          <span className="crm-section__icon cust-tone--file" aria-hidden>
            <BagIcon />
          </span>
          {t("customers.suppliers.history.title")}
          {!loading && !error ? <span className="crm-section__count">{total}</span> : null}
        </h2>
        <a className="sup-link sup-link--head" href="/inventory/supplier-purchases/new">
          + {t("customers.suppliers.history.newOrder")}
        </a>
      </div>

      {loading ? (
        <div className="crm-list" aria-busy="true">
          <div className="crm-skel" style={{ height: 64 }} />
          <div className="crm-skel" style={{ height: 64 }} />
        </div>
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            {t("customers.suppliers.history.retry")}
          </button>
        </div>
      ) : summary && total === 0 ? (
        <p className="sup-empty">{t("customers.suppliers.history.emptyTitle")}</p>
      ) : summary ? (
        <>
          <div className="crm-chips">
            <span className="crm-chip">{t("customers.suppliers.history.totalOrders", { count: summary.purchaseOrderCount })}</span>
            <span className="crm-chip">{t("customers.suppliers.history.openOrders", { count: summary.openPurchaseOrderCount })}</span>
            {summary.lastPurchaseOrderAt ? (
              <span className="crm-chip">
                {t("customers.suppliers.history.lastOrder", { date: formatPurchaseDate(summary.lastPurchaseOrderAt, locale) ?? "" })}
              </span>
            ) : null}
            {formatSupplierMoney(summary.receivedValue, locale) ? (
              <span className="crm-chip">
                {t("customers.suppliers.history.received", { amount: formatSupplierMoney(summary.receivedValue, locale) ?? "" })}
              </span>
            ) : null}
            {formatSupplierMoney(summary.orderedValue, locale) ? (
              <span className="crm-chip">
                {t("customers.suppliers.history.ordered", { amount: formatSupplierMoney(summary.orderedValue, locale) ?? "" })}
              </span>
            ) : null}
          </div>

          {costCoverageNote(summary.linesWithoutCost, summary.totalLineCount, t) ? (
            <p className="crm-item__meta" style={{ marginTop: 4 }}>
              {costCoverageNote(summary.linesWithoutCost, summary.totalLineCount, t)}
            </p>
          ) : null}

          {purchasedItems.length > 0 ? (
            <>
              <div className="crm-seclabel" style={{ fontWeight: 600, marginTop: 14 }}>
                {t("customers.suppliers.history.purchasedTitle")}
              </div>
              <div className="crm-list">
                {purchasedItems.map((item) => (
                  <PurchasedItemRow key={item.itemId} item={item} />
                ))}
              </div>
            </>
          ) : null}

          <div className="crm-list">
            {(expanded ? items : items.slice(0, PREVIEW_ORDERS)).map((item) => (
              <PurchaseOrderRow key={item.id} item={item} supplierName={supplierName} />
            ))}
          </div>

          {!expanded && items.length > PREVIEW_ORDERS ? (
            <button type="button" className="sup-link" aria-expanded={false} onClick={() => setExpanded(true)}>
              {t("customers.customer.card.showMore", { count: items.length - PREVIEW_ORDERS })}
            </button>
          ) : expanded && pagination?.hasMore ? (
            <div className="crm-list-more" style={{ marginTop: 12 }} aria-live="polite">
              {moreError ? <p className="crm-list-more__error" role="alert">{moreError}</p> : null}
              <button
                type="button"
                className="crm-btn crm-btn--ghost crm-btn--full"
                onClick={() => void loadMore()}
                disabled={!canLoadMore(pagination.hasMore, loadingMore)}
              >
                {loadingMore
                  ? t("customers.suppliers.history.loading")
                  : moreError
                    ? t("customers.suppliers.history.retry")
                    : t("customers.suppliers.history.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One purchased item: how much of it, in how many orders, and whether its unit
 * cost moved. Every number here is read straight off the purchase lines.
 */
function PurchasedItemRow({ item }: { item: SupplierPurchasedItem }) {
  const { t, locale } = useI18n();
  const trend = priceTrend(item.firstUnitCost, item.lastUnitCost);
  const lastCost = formatSupplierMoney(item.lastUnitCost, locale);

  const meta = [
    t("customers.suppliers.history.qtyUnits", { qty: item.totalQty.toLocaleString(intlTag(locale)) }),
    item.orderCount === 1 ? t("customers.suppliers.history.ordersOne") : t("customers.suppliers.history.ordersMany", { count: item.orderCount }),
    lastCost ? t("customers.suppliers.history.lastPrice", { price: lastCost }) : null,
    trend && trend !== "SAME" ? t(PRICE_TREND_LABEL_KEY[trend]) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="crm-item">
      <div className="crm-item__main">
        <div className="crm-item__title">
          <bdi>{item.name}</bdi>
        </div>
        <div className="crm-item__meta">
          <bdi>{meta}</bdi>
        </div>
      </div>
    </div>
  );
}

function PurchaseOrderRow({
  item,
  supplierName,
}: {
  item: SupplierPurchaseOrderItem;
  supplierName: string;
}) {
  const { t, locale } = useI18n();
  const badge = statusBadge(item.status, t);
  const createdAtStr = formatPurchaseDate(item.createdAt, locale);
  const lineText = formatLineCount(item.lineCount, t);

  // Show the historical snapshot name only when it differs from the current name.
  const snapshot = item.supplierName?.trim();
  const showSnapshot = !!snapshot && snapshot !== supplierName.trim();

  // Business order date is a secondary hint, shown only when present and distinct.
  const orderDateStr = formatPurchaseDate(item.orderDate, locale);
  const showOrderDate = !!orderDateStr && orderDateStr !== createdAtStr;

  const metaParts = [createdAtStr, lineText];
  const orderValue = formatSupplierMoney(item.orderedValue, locale);
  if (showOrderDate) metaParts.push(t("customers.suppliers.history.orderedFrom", { date: orderDateStr ?? "" }));
  const meta = metaParts.filter(Boolean).join(" · ");

  return (
    <div className="crm-item">
      <div className="crm-item__main">
        <div className="crm-item__title">
          <span className={badge.className}>{badge.label}</span>
          {showSnapshot ? <span> · {snapshot}</span> : null}
        </div>
        {meta ? <div className="crm-item__meta">{meta}</div> : null}
      </div>
      {orderValue ? (
        <div className="crm-item__amount">
          <bdi>{orderValue}</bdi>
        </div>
      ) : null}
    </div>
  );
}
