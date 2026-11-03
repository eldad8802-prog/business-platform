"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getInventoryItems, getPurchaseOrder, type InventoryItemDTO, type PurchaseOrderDTO } from "@/lib/api/inventory";
import { redirectToLogin } from "@/lib/client-session";
import { receiveLineQuantities } from "@/lib/inventory/receive-remainder";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import { formatOrderDate, poOpenQty, poStatus } from "@/lib/inventory/purchase-order-view";
import { InvButton, InvError, InvLoading, InvPage, InvState, InvStatus, ProductThumb } from "@/components/inventory/v2/kit";

/**
 * Purchase order detail (new, read-only). Shows what was ordered, received and is
 * still open per line — the same numbers the receive screen uses
 * (receiveLineQuantities). The only action is "לקבלת סחורה" while something is open.
 */
export default function PurchaseOrderDetailPage() {
  const params = useParams();
  const raw = params?.poId;
  const poId = Number(Array.isArray(raw) ? raw[0] : raw);
  const [po, setPo] = useState<PurchaseOrderDTO | null>(null);
  const [items, setItems] = useState<Map<number, InventoryItemDTO>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!poId || Number.isNaN(poId)) {
      setError("מספר ההזמנה אינו תקין.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getPurchaseOrder(poId);
      setPo(data);
    } catch (err) {
      if (err instanceof Error && err.message === "UNAUTHORIZED") return redirectToLogin();
      setError(err instanceof Error && /not found/i.test(err.message) ? "ההזמנה לא נמצאה." : null);
      setPo(null);
    } finally {
      setLoading(false);
    }
    // Names and images only — optional.
    void getInventoryItems()
      .then((list) => setItems(new Map(list.map((i) => [i.id, i]))))
      .catch(() => setItems(new Map()));
  }, [poId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const open = useMemo(() => (po ? poOpenQty(po) : 0), [po]);
  const status = po ? poStatus(po) : null;

  return (
    <InvPage
      title="פרטי הזמנה"
      backFallback="/inventory/supplier-purchases"
      footer={
        po && open > 0 ? (
          <div className="i2-footer__row">
            <InvButton href={`/inventory/supplier-purchases/${po.id}/receive`}>לקבלת סחורה</InvButton>
          </div>
        ) : undefined
      }
    >
      {loading ? (
        <InvLoading rows={4} />
      ) : !po ? (
        <InvError message={error ?? undefined} onRetry={() => void load()} />
      ) : (
        <>
          <p className="i2-row__kicker" style={{ margin: "8px 0 0" }}>הזמנת רכש</p>
          <h2 className="i2-h2" style={{ marginTop: 2 }}>
            <bdi>הזמנה {po.externalOrderId ? `#${po.externalOrderId}` : po.id}</bdi>
          </h2>
          <dl className="i2-kv">
            <div className="i2-kv__r">
              <dt>ספק</dt>
              <dd>
                {po.supplierId != null ? (
                  <Link href={`/suppliers/${po.supplierId}`} style={{ color: "var(--i2-green-ink)" }}>
                    <bdi>{po.supplierName?.trim() || "כרטיס ספק"}</bdi>
                  </Link>
                ) : (
                  <bdi>{po.supplierName?.trim() || "ללא ספק"}</bdi>
                )}
              </dd>
            </div>
            <div className="i2-kv__r">
              <dt>סטטוס</dt>
              <dd>{status ? <InvStatus tone={status.tone}>{status.label}</InvStatus> : null}</dd>
            </div>
            <div className="i2-kv__r">
              <dt>תאריך הזמנה</dt>
              <dd className="i2-num">{formatOrderDate(po.orderDate ?? po.createdAt) || "—"}</dd>
            </div>
          </dl>

          <h3 className="i2-h3">מוצרים בהזמנה</h3>
          {po.lines.length === 0 ? (
            <InvState title="אין שורות בהזמנה" action={<InvButton kind="secondary" href="/inventory/supplier-purchases">חזרה להזמנות</InvButton>} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="i2-table">
                <thead>
                  <tr>
                    <th>מוצר</th>
                    <th>הוזמן</th>
                    <th>התקבל</th>
                    <th>נותר</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((line) => {
                    const item = line.itemId != null ? items.get(line.itemId) : undefined;
                    const name = line.rawName?.trim() || item?.name || "מוצר ללא שם";
                    const unit = line.unitType ?? item?.unitType ?? null;
                    const qn = receiveLineQuantities(line, 0);
                    const remaining = po.status === "CLOSED" || po.status === "CANCELLED" ? 0 : qn.open;
                    return (
                      <tr key={line.id}>
                        <td>
                          <span className="i2-cellprod">
                            <ProductThumb src={item?.imageUrl} name={name} size={40} />
                            <span style={{ overflowWrap: "anywhere" }}>{name}</span>
                          </span>
                        </td>
                        <td className="i2-num">{qtyWithUnit(qn.ordered, unit)}</td>
                        <td className="i2-num">{qtyWithUnit(qn.receivedBefore, unit)}</td>
                        <td className="i2-num">
                          {qtyWithUnit(remaining, unit)}
                          {qn.closedShortBefore > 0 ? (
                            <span className="i2-muted" style={{ display: "block", fontSize: 13 }}>
                              נסגרו כחוסר {qtyWithUnit(qn.closedShortBefore, unit)}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {open <= 0 ? <p className="i2-foot">אין יתרה פתוחה לקבלה בהזמנה זו.</p> : null}
        </>
      )}
    </InvPage>
  );
}
