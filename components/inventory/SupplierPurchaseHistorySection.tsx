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
  PRICE_TREND_LABEL,
  statusBadge,
} from "@/lib/inventory/supplier-purchase-history-view";

const PAGE_SIZE = 10;

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
 */
export function SupplierPurchaseHistorySection({ supplierId, supplierName }: Props) {
  const [summary, setSummary] = useState<SupplierPurchaseHistory["summary"] | null>(null);
  const [items, setItems] = useState<SupplierPurchaseOrderItem[]>([]);
  const [purchasedItems, setPurchasedItems] = useState<SupplierPurchasedItem[]>(
    []
  );
  const [pagination, setPagination] = useState<SupplierPurchaseHistory["pagination"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Retry re-runs the first-page effect by bumping this key (event-driven setState),
  // which keeps the effect body's own setState calls all post-await.
  const [reloadKey, setReloadKey] = useState(0);

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
        setError("לא הצלחנו לטעון את היסטוריית הרכש כרגע.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [supplierId, reloadKey]);

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
      // A failed "load more" keeps the already-loaded rows and the rest of the card.
      setError("לא הצלחנו לטעון עוד הזמנות רכש כרגע.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [supplierId, pagination]);

  const total = summary?.purchaseOrderCount ?? pagination?.total ?? 0;

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">היסטוריית רכש</h2>
        {!loading && !error ? <span className="crm-section__count">{total}</span> : null}
        <a
          className="crm-btn crm-btn--ghost"
          href="/inventory/supplier-purchases/new"
          style={{ marginInlineStart: "auto" }}
        >
          הזמנה חדשה
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
            נסו שוב
          </button>
        </div>
      ) : summary && total === 0 ? (
        <div className="crm-panel">
          <p className="crm-panel__title">עדיין אין היסטוריית רכש</p>
          <p className="crm-panel__body">
            הזמנה שנוצרת עם הספק הזה תופיע כאן, יחד עם הפריטים והעלויות.
          </p>
          <a
            className="crm-btn crm-btn--primary"
            href="/inventory/supplier-purchases/new"
          >
            הזמנה חדשה מהספק
          </a>
        </div>
      ) : summary ? (
        <>
          <div className="crm-chips">
            <span className="crm-chip">סה״כ הזמנות · {summary.purchaseOrderCount}</span>
            <span className="crm-chip">פתוחות · {summary.openPurchaseOrderCount}</span>
            {summary.lastPurchaseOrderAt ? (
              <span className="crm-chip">
                הזמנה אחרונה · {formatPurchaseDate(summary.lastPurchaseOrderAt)}
              </span>
            ) : null}
            {formatSupplierMoney(summary.receivedValue) ? (
              <span className="crm-chip">
                נקלט בפועל · {formatSupplierMoney(summary.receivedValue)}
              </span>
            ) : null}
            {formatSupplierMoney(summary.orderedValue) ? (
              <span className="crm-chip">
                סה״כ הוזמן · {formatSupplierMoney(summary.orderedValue)}
              </span>
            ) : null}
          </div>

          {costCoverageNote(summary.linesWithoutCost, summary.totalLineCount) ? (
            <p className="crm-item__meta" style={{ marginTop: 4 }}>
              {costCoverageNote(summary.linesWithoutCost, summary.totalLineCount)}
            </p>
          ) : null}

          {purchasedItems.length > 0 ? (
            <>
              <div className="crm-seclabel" style={{ fontWeight: 600, marginTop: 14 }}>
                מה נקנה מהספק
              </div>
              <div className="crm-list">
                {purchasedItems.map((item) => (
                  <PurchasedItemRow key={item.itemId} item={item} />
                ))}
              </div>
            </>
          ) : null}

          <div className="crm-list">
            {items.map((item) => (
              <PurchaseOrderRow key={item.id} item={item} supplierName={supplierName} />
            ))}
          </div>

          {pagination?.hasMore ? (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="crm-btn crm-btn--ghost crm-btn--full"
                onClick={() => void loadMore()}
                disabled={!canLoadMore(pagination.hasMore, loadingMore)}
              >
                {loadingMore ? "טוען…" : "טען עוד"}
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
  const trend = priceTrend(item.firstUnitCost, item.lastUnitCost);
  const lastCost = formatSupplierMoney(item.lastUnitCost);

  const meta = [
    `${item.totalQty.toLocaleString("he-IL")} יח׳`,
    item.orderCount === 1 ? "הזמנה אחת" : `${item.orderCount} הזמנות`,
    lastCost ? `מחיר אחרון ${lastCost}` : null,
    trend && trend !== "SAME" ? PRICE_TREND_LABEL[trend] : null,
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
  const badge = statusBadge(item.status);
  const createdAtStr = formatPurchaseDate(item.createdAt);
  const lineText = formatLineCount(item.lineCount);

  // Show the historical snapshot name only when it differs from the current name.
  const snapshot = item.supplierName?.trim();
  const showSnapshot = !!snapshot && snapshot !== supplierName.trim();

  // Business order date is a secondary hint, shown only when present and distinct.
  const orderDateStr = formatPurchaseDate(item.orderDate);
  const showOrderDate = !!orderDateStr && orderDateStr !== createdAtStr;

  const metaParts = [createdAtStr, lineText];
  const orderValue = formatSupplierMoney(item.orderedValue);
  if (orderValue) metaParts.push(orderValue);
  if (showOrderDate) metaParts.push(`הזמנה מ־${orderDateStr}`);
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
    </div>
  );
}
