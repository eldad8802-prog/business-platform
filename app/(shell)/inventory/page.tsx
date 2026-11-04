"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { deriveHomeSummary, formatStockValue, selectAttentionItems } from "@/components/inventory/home/home-logic";
import { I2, InvButton, InvError, InvLoading, InvPage, InvPill, InvRow, InvState, ProductThumb } from "@/components/inventory/v2/kit";
import { stockLine, TONE_WORD } from "@/lib/inventory/stock-line";
import {
  loadPendingOrderDrafts,
  loadPendingProductDrafts,
  loadPendingSales,
  type PendingOrderDraft,
  type PendingProductDraft,
  type PendingSale,
} from "@/lib/inventory/overview-sources";

/**
 * Inventory overview (redesign, owner-approved mockup "מלאי · סקירה").
 * Numbers come from the same derivations as before (deriveHomeSummary,
 * selectAttentionItems, getStockTone). Drafts, unmatched sales and orders awaiting
 * receipt come from their existing endpoints; each is optional.
 */
export default function InventoryOverviewPage() {
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [drafts, setDrafts] = useState<PendingProductDraft[]>([]);
  const [sales, setSales] = useState<PendingSale[]>([]);
  const [orders, setOrders] = useState<PendingOrderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setError(true);
    } finally {
      setLoading(false);
    }
    void loadPendingProductDrafts().then(setDrafts).catch(() => setDrafts([]));
    void loadPendingSales().then(setSales).catch(() => setSales([]));
    void loadPendingOrderDrafts().then(setOrders).catch(() => setOrders([]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!getClientAuthToken()) redirectToLogin();
      else void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(() => deriveHomeSummary(items), [items]);
  const stock = useMemo(() => selectAttentionItems(items), [items]);

  const entries: Array<{ key: string; node: ReactNode }> = [
    ...stock.map((item) => {
      const line = stockLine(item);
      return {
        key: `i${item.id}`,
        node: (
          <InvRow
            key={`i${item.id}`}
            href={`/inventory/items/${item.id}`}
            thumb={<ProductThumb src={item.imageUrl} name={item.name} />}
            title={item.name}
            dot={line.tone === "critical" ? "danger" : "warn"}
            sub={line.text}
            subTone={line.tone === "critical" ? "danger" : undefined}
            ariaLabel={`${item.name} · ${TONE_WORD[line.tone]} · ${line.text}`}
            trail={<InvPill href={`/inventory/supplier-purchases/new?item=${item.id}`} ariaLabel={`הזמנה מספק · ${item.name}`}>הזמן</InvPill>}
          />
        ),
      };
    }),
    ...drafts.map((d) => ({
      key: `d${d.id}`,
      node: (
        <InvRow key={`d${d.id}`} href="/inventory/drafts" thumb={<ProductThumb src={d.imageUrl} name={d.name} />} kicker="טיוטת מוצר" title={d.name} sub="ממתינה לבדיקה ואישור" trail={<InvPill href="/inventory/drafts">בדיקה</InvPill>} />
      ),
    })),
    ...sales.map((s) => ({
      key: `s${s.id}`,
      node: (
        <InvRow key={`s${s.id}`} href="/inventory/unmatched" thumb={<ProductThumb name="ש" />} kicker="שיוך מכירה" title={s.name} sub="פריט במכירה ללא מוצר במלאי" trail={<InvPill href="/inventory/unmatched">שייך</InvPill>} />
      ),
    })),
    ...orders.map((o) => ({
      key: `o${o.id}`,
      node: (
        <InvRow
          key={`o${o.id}`}
          href={`/inventory/supplier-purchases/${o.id}/send`}
          thumb={<ProductThumb name="ה" />}
          kicker="הזמנה מספק"
          title={o.supplierName ? `הזמנה מ${o.supplierName}` : "הזמנה ללא ספק"}
          sub={`ממתינה לקליטה · ${o.lineCount} ${o.lineCount === 1 ? "מוצר" : "מוצרים"}`}
          trail={<InvPill href={`/inventory/supplier-purchases/${o.id}/send`}>לצפייה</InvPill>}
        />
      ),
    })),
  ];

  return (
    <InvPage title="מלאי" tabs="overview" backFallback="/app">
      {loading ? (
        <InvLoading rows={5} />
      ) : error ? (
        <InvError onRetry={() => void load()} />
      ) : (
        <>
          <div className="i2-stats" aria-label="תמונת מצב">
            <div className="i2-stat">
              <div className="i2-stat__v i2-num">{summary.activeCount}</div>
              <div className="i2-stat__l">מוצרים</div>
            </div>
            <div className="i2-stat">
              <div className="i2-stat__v i2-num">{entries.length}</div>
              <div className="i2-stat__l">דורשים טיפול</div>
            </div>
            <div className="i2-stat">
              <div className="i2-stat__v i2-num">₪{formatStockValue(summary.stockValue)}</div>
              <div className="i2-stat__l">שווי מלאי</div>
            </div>
          </div>

          <div className="i2-tiles" style={{ marginTop: 14 }}>
            <Link className="i2-tile i2-tile--c i2-tile--new" href="/inventory/items/create">
              <span>מוצר חדש</span>
              {I2.plus(24)}
            </Link>
            <Link className="i2-tile i2-tile--c i2-tile--count" href="/inventory/count">
              <span>ספירת מלאי</span>
              {I2.list(24)}
            </Link>
            <Link className="i2-tile i2-tile--c i2-tile--order" href="/inventory/supplier-purchases/new">
              <span>הזמנה מספק</span>
              {I2.truck(24)}
            </Link>
            <Link className="i2-tile i2-tile--c i2-tile--receive" href="/inventory/supplier-purchases/pending">
              <span>קבלת סחורה</span>
              {I2.box(24)}
            </Link>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            <Link className="i2-link" href="/inventory/sales/create">
              רישום מכירה ידנית {I2.chevronEnd(16)}
            </Link>
            <Link className="i2-link" href="/settings/import-export">
              ייבוא וייצוא מוצרים {I2.chevronEnd(16)}
            </Link>
          </div>

          {items.length === 0 ? (
            <InvState
              title="עוד אין מוצרים במלאי"
              body="הוסיפו מוצר ראשון, או ייבאו רשימת מוצרים מקובץ."
              action={
                <div className="i2-actions" style={{ maxWidth: 420, margin: "0 auto" }}>
                  <InvButton href="/inventory/items/create">הוספת מוצר</InvButton>
                  <InvButton kind="secondary" href="/settings/import-export">ייבוא מקובץ</InvButton>
                </div>
              }
            />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <h2 className="i2-h2">דורש טיפול</h2>
                {entries.length > 4 ? (
                  <Link className="i2-link" href="/inventory/alerts">
                    הצגת הכול ({entries.length}) {I2.chevronEnd(16)}
                  </Link>
                ) : null}
              </div>
              {entries.length === 0 ? (
                <p className="i2-muted" style={{ margin: "4px 0 0" }}>אין כרגע מה לטפל בו.</p>
              ) : (
                <ul className="i2-list">{entries.slice(0, 4).map((e) => e.node)}</ul>
              )}
              <p className="i2-foot">המלאי מתעדכן לפי התנועות שנרשמו בדוביז</p>
            </>
          )}
        </>
      )}
    </InvPage>
  );
}
