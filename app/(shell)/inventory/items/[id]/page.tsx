"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  getInventoryItemById,
  getInventoryMovementsByItemId,
  resolveInventoryAlert,
  type InventoryMovementDTO,
} from "@/lib/api/inventory";
import InventoryItemImageUploader from "@/components/inventory/inventory-item-image-uploader";
import InventoryMovementForm from "@/components/inventory/inventory-movement-form";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { getMovementReasonLabel } from "@/lib/inventory/inventory-labels";

type InventoryItemDetails = {
  id: number;
  name: string;
  barcode: string | null;
  supplierName?: string | null;
  unitType: string;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  imageUrl?: string | null;
  alerts?: Array<{
    id: number;
    type?: string;
    alertType?: string;
    message?: string | null;
    createdAt?: string;
  }>;
};

type ItemStatus = {
  tone: "critical" | "low" | "ok";
  label: string;
  description: string;
};

const UNIT_LABELS: Record<string, string> = {
  UNIT: "יחידה",
  ML: 'מ"ל',
  GRAM: "גרם",
  KG: "קילוגרם",
  LITER: "ליטר",
  BOX: "קופסה",
};

const itemDetailCss = `
[data-inventory-item-truth] {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.item-truth-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
  padding: 18px;
}

.item-status-card {
  border-color: #dbeafe;
  background: linear-gradient(180deg, #ffffff, #f8fbff);
}

.item-status-pill {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 900;
}

.item-status-pill--critical {
  background: #fee2e2;
  color: #dc2626;
}

.item-status-pill--low {
  background: #fef3c7;
  color: #b45309;
}

.item-status-pill--ok {
  background: #dcfce7;
  color: #166534;
}

.item-status-card h1 {
  margin: 12px 0 6px;
  color: #0f172a;
  font-size: 1.35rem;
  line-height: 1.2;
  font-weight: 900;
}

.item-status-card p {
  margin: 0;
  color: #64748b;
  font-size: 0.92rem;
  line-height: 1.55;
}

.item-understand-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
}

.item-metric {
  border-radius: 16px;
  background: #f8fafc;
  padding: 12px;
}

.item-metric span {
  display: block;
  color: #64748b;
  font-size: 0.76rem;
  font-weight: 800;
}

.item-metric strong {
  display: block;
  margin-top: 5px;
  color: #0f172a;
  font-size: 1.2rem;
  line-height: 1;
}

.item-section-title {
  margin: 0 0 10px;
  color: #0f172a;
  font-size: 1rem;
  line-height: 1.35;
  font-weight: 900;
}

.item-section-copy {
  margin: 0 0 14px;
  color: #64748b;
  font-size: 0.88rem;
  line-height: 1.55;
}

.item-next-button {
  width: 100%;
  min-height: 48px;
  border: 0;
  border-radius: 15px;
  background: #0f766e;
  color: #ffffff;
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.item-next-button:focus-visible,
.item-alert-button:focus-visible {
  outline: 3px solid rgba(15, 118, 110, 0.25);
  outline-offset: 2px;
}

.item-details-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 10px;
}

.item-detail-box {
  border-radius: 15px;
  background: #f8fafc;
  border: 1px solid #eef2f7;
  padding: 12px;
}

.item-detail-box span {
  display: block;
  color: #64748b;
  font-size: 0.76rem;
  font-weight: 800;
  margin-bottom: 5px;
}

.item-detail-box strong {
  display: block;
  color: #0f172a;
  font-size: 0.92rem;
  line-height: 1.35;
  word-break: break-word;
}

.item-alert-list,
.item-movement-list {
  display: grid;
  gap: 10px;
}

.item-alert-row,
.item-movement-row {
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #ffffff;
  padding: 12px;
}

.item-alert-row {
  background: #fffbeb;
  border-color: #fde68a;
  color: #92400e;
}

.item-alert-top,
.item-movement-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.item-alert-button {
  min-height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 11px;
  background: #ffffff;
  color: #0f172a;
  padding: 8px 12px;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 900;
  cursor: pointer;
}

.item-movement-delta {
  display: inline-flex;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 900;
}

.item-movement-delta--in {
  background: #dcfce7;
  color: #166534;
}

.item-movement-delta--out {
  background: #fee2e2;
  color: #991b1b;
}

.item-empty-state {
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #f8fafc;
  padding: 18px;
  color: #64748b;
  text-align: center;
  font-size: 0.9rem;
}

@media (max-width: 380px) {
  .item-understand-grid {
    grid-template-columns: 1fr;
  }
}
`;

function getSafeImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return null;
  if (imageUrl.includes("example.com")) return null;
  return imageUrl;
}

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function getAlertLabel(type?: string) {
  if (type === "CRITICAL_STOCK") return "מלאי קריטי";
  if (type === "LOW_STOCK") return "מלאי נמוך";
  if (type === "SUSPICIOUS_CORRECTION") return "פעולה חריגה";
  return type || "התראה";
}

function getStatus(item: InventoryItemDetails): ItemStatus {
  if (item.currentQuantity <= item.minimumQuantity) {
    return {
      tone: "critical",
      label: "מצב קריטי",
      description: "הכמות הנוכחית הגיעה למינימום או מתחתיו. כדאי לטפל בפריט עכשיו.",
    };
  }

  if (item.reorderPoint !== null && item.currentQuantity <= item.reorderPoint) {
    return {
      tone: "low",
      label: "דורש תשומת לב",
      description: "הפריט עדיין קיים, אבל נמצא באזור שבו כדאי לשקול הזמנה או עדכון מלאי.",
    };
  }

  return {
    tone: "ok",
    label: "תקין",
    description: "המלאי של הפריט נראה מאוזן כרגע ואין פעולה דחופה.",
  };
}

export default function InventoryItemPage() {
  const params = useParams();

  const itemId = useMemo(() => {
    const rawId = params?.id;
    const value = Array.isArray(rawId) ? rawId[0] : rawId;
    const parsed = Number(value);

    return Number.isNaN(parsed) ? null : parsed;
  }, [params]);

  const [item, setItem] = useState<InventoryItemDetails | null>(null);
  const [movements, setMovements] = useState<InventoryMovementDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingAlertId, setResolvingAlertId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadItemData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!itemId) {
        setError("מזהה מוצר לא תקין");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      try {
        if (options?.silent) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        setError(null);

        const [itemData, movementsData] = await Promise.all([
          getInventoryItemById(itemId),
          getInventoryMovementsByItemId(itemId),
        ]);

        setItem(itemData);
        setMovements(Array.isArray(movementsData) ? movementsData : []);
      } catch (err: unknown) {
        const message = getErrorMessage(err, "שגיאה בטעינת פרטי הפריט");

        if (message === "UNAUTHORIZED") {
          setError("אין הרשאה לצפות בפרטי הפריט. צריך להתחבר מחדש.");
        } else if (message === "NOT_FOUND") {
          setError("הפריט לא נמצא");
        } else {
          setError(message);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [itemId]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadItemData();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadItemData]);

  async function handleResolveAlert(alertId: number) {
    if (resolvingAlertId) return;

    try {
      setResolvingAlertId(alertId);
      setError(null);

      await resolveInventoryAlert(alertId);
      await loadItemData({ silent: true });
    } catch (err: unknown) {
      setError(getErrorMessage(err, "שגיאה בסגירת ההתראה"));
    } finally {
      setResolvingAlertId(null);
    }
  }

  if (loading) {
    return (
      <InventorySubPage title="פרטי פריט" backHref="/inventory/items" backLabel="כל הפריטים" bottomNav="products">
        <style>{itemDetailCss}</style>
        <section className="item-empty-state">טוען פרטי פריט...</section>
      </InventorySubPage>
    );
  }

  if (error && !item) {
    return (
      <InventorySubPage title="פרטי פריט" backHref="/inventory/items" backLabel="כל הפריטים" bottomNav="products">
        <style>{itemDetailCss}</style>
        <section className="item-empty-state" role="alert">
          <strong>משהו השתבש</strong>
          <div style={{ marginTop: 8, marginBottom: 14 }}>{error}</div>
          <button type="button" className="item-next-button" onClick={() => void loadItemData()}>
            נסה שוב
          </button>
        </section>
      </InventorySubPage>
    );
  }

  if (!item) {
    return (
      <InventorySubPage title="פרטי פריט" backHref="/inventory/items" backLabel="כל הפריטים" bottomNav="products">
        <style>{itemDetailCss}</style>
        <section className="item-empty-state">לא נמצאו נתוני פריט</section>
      </InventorySubPage>
    );
  }

  const status = getStatus(item);
  const safeImageUrl = getSafeImageUrl(item.imageUrl);
  const nextAction =
    status.tone === "ok" ? "לעדכן תנועה רק אם משהו השתנה בפועל" : "לעדכן מלאי או לפתוח הזמנה לפי הצורך";

  return (
    <InventorySubPage title={item.name} backHref="/inventory/items" backLabel="כל הפריטים" bottomNav="products">
      <style>{itemDetailCss}</style>

      <div data-inventory-item-truth>
        {refreshing ? <div style={{ fontSize: 13, color: "#64748b", textAlign: "center" }}>מעדכן נתוני פריט...</div> : null}

        {error && item ? (
          <section className="item-empty-state" role="alert">
            {error}
          </section>
        ) : null}

        <section className="item-truth-card item-status-card">
          <span className={`item-status-pill item-status-pill--${status.tone}`}>{status.label}</span>
          <h1>{item.name}</h1>
          <p>{status.description}</p>

          <div className="item-understand-grid" aria-label="מצב מלאי">
            <Metric label="כמות עכשיו" value={item.currentQuantity} />
            <Metric label="מינימום" value={item.minimumQuantity} />
            <Metric label="נקודת הזמנה" value={item.reorderPoint ?? "לא הוגדרה"} />
          </div>
        </section>

        <section className="item-truth-card">
          <h2 className="item-section-title">מה צריך להבין</h2>
          <p className="item-section-copy">{nextAction}</p>
          <div className="item-details-grid">
            <InfoCard label="יחידת מידה" value={UNIT_LABELS[item.unitType] || item.unitType} />
            <InfoCard label="ספק" value={item.supplierName || "לא הוגדר"} />
            <InfoCard label="ברקוד" value={item.barcode || "לא הוגדר"} />
          </div>
        </section>

        <section id="inventory-next-action" className="item-truth-card">
          <h2 className="item-section-title">הפעולה הבאה</h2>
          <p className="item-section-copy">עדכן תנועה רק כאשר יש שינוי אמיתי במלאי.</p>
          <InventoryMovementForm itemId={item.id} onSuccess={() => loadItemData({ silent: true })} />
        </section>

        <section className="item-truth-card">
          <h2 className="item-section-title">פרטי הפריט</h2>
          <div style={{ marginBottom: 14 }}>
            <InventoryItemImageUploader
              itemId={item.id}
              imageUrl={safeImageUrl}
              onUpdated={(updated) =>
                setItem((current) => {
                  if (!current) return current;
                  return { ...current, ...updated };
                })
              }
            />
          </div>
          <div className="item-details-grid">
            <InfoCard label="שם פריט" value={item.name} />
            <InfoCard label="כמות נוכחית" value={item.currentQuantity} />
            <InfoCard label="מינימום רצוי" value={item.minimumQuantity} />
            <InfoCard label="נקודת הזמנה" value={item.reorderPoint ?? "לא הוגדרה"} />
          </div>
        </section>

        {item.alerts && item.alerts.length > 0 ? (
          <section className="item-truth-card">
            <h2 className="item-section-title">התראות פתוחות</h2>
            <div className="item-alert-list">
              {item.alerts.map((alert) => {
                const alertType = alert.type || alert.alertType;
                const isResolving = resolvingAlertId === alert.id;

                return (
                  <div key={alert.id} className="item-alert-row">
                    <div className="item-alert-top">
                      <strong>{getAlertLabel(alertType)}</strong>
                      <button
                        type="button"
                        className="item-alert-button"
                        disabled={isResolving || resolvingAlertId !== null}
                        onClick={() => handleResolveAlert(alert.id)}
                      >
                        {isResolving ? "סוגר..." : "טופל"}
                      </button>
                    </div>
                    {alert.message ? <div style={{ marginTop: 8 }}>{alert.message}</div> : null}
                    {alert.createdAt ? (
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                        {new Date(alert.createdAt).toLocaleString("he-IL")}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="item-truth-card">
          <h2 className="item-section-title">היסטוריה</h2>
          <MovementsList movements={movements} />
        </section>
      </div>
    </InventorySubPage>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="item-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="item-detail-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MovementsList({ movements }: { movements: InventoryMovementDTO[] }) {
  if (!movements.length) {
    return <div className="item-empty-state">אין תנועות עדיין</div>;
  }

  return (
    <div className="item-movement-list">
      {movements.map((movement) => {
        const isIn = movement.quantityDelta >= 0;
        const deltaClass = isIn ? "item-movement-delta--in" : "item-movement-delta--out";

        return (
          <article key={movement.id} className="item-movement-row">
            <div className="item-movement-top">
              <strong>{getMovementReasonLabel(movement.reason)}</strong>
              <span className={`item-movement-delta ${deltaClass}`}>
                {isIn ? "+" : ""}
                {movement.quantityDelta}
              </span>
            </div>
            <div style={{ marginTop: 8, color: "#475569", fontSize: 13 }}>
              לפני: {movement.quantityBefore} · אחרי: <strong>{movement.quantityAfter}</strong>
            </div>
            {movement.note ? (
              <div style={{ marginTop: 8, color: "#475569", fontSize: 13 }}>הערה: {movement.note}</div>
            ) : null}
            <div style={{ marginTop: 8, color: "#64748b", fontSize: 12 }}>
              {new Date(movement.createdAt).toLocaleString("he-IL")}
            </div>
          </article>
        );
      })}
    </div>
  );
}
