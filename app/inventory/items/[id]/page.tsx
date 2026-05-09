"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  getInventoryItemById,
  getInventoryMovementsByItemId,
  resolveInventoryAlert,
} from "@/lib/api/inventory";
import InventoryMovementsList from "@/components/inventory/inventory-movements-list";
import InventoryItemImageUploader from "@/components/inventory/inventory-item-image-uploader";
import InventoryMovementForm from "@/components/inventory/inventory-movement-form";
import PageHeader from "@/components/ui/page-header";

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

const UNIT_LABELS: Record<string, string> = {
  UNIT: "יחידה",
  ML: 'מ"ל',
  GRAM: "גרם",
  KG: "קילוגרם",
  LITER: "ליטר",
  BOX: "קופסה",
};

function getSafeImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return null;
  if (imageUrl.includes("example.com")) return null;
  return imageUrl;
}

function getAlertLabel(type?: string) {
  if (type === "CRITICAL_STOCK") return "מלאי קריטי";
  if (type === "LOW_STOCK") return "מלאי נמוך";
  if (type === "SUSPICIOUS_CORRECTION") return "פעולה חריגה";
  return type || "התראה";
}

function InfoCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid #f1f5f9",
        borderRadius: "14px",
        padding: "12px",
        background: "#f8fafc",
      }}
    >
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "6px" }}>
        {label}
      </div>

      <div
        style={{
          fontSize: "14px",
          fontWeight: 700,
          color: "#111827",
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
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
  const [movements, setMovements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingAlertId, setResolvingAlertId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useMemo(() => {
    if (!item) return null;

    if (item.currentQuantity <= item.minimumQuantity) {
      return {
        label: "מלאי קריטי",
        color: "#dc2626",
        background: "#fee2e2",
      };
    }

    if (
      item.reorderPoint !== null &&
      item.currentQuantity <= item.reorderPoint
    ) {
      return {
        label: "מלאי נמוך",
        color: "#b45309",
        background: "#fef3c7",
      };
    }

    return {
      label: "מלאי תקין",
      color: "#166534",
      background: "#dcfce7",
    };
  }, [item]);

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
      } catch (err: any) {
        if (err?.message === "UNAUTHORIZED") {
          setError("אין הרשאה לצפות בפרטי הפריט. צריך להתחבר מחדש.");
        } else if (err?.message === "NOT_FOUND") {
          setError("הפריט לא נמצא");
        } else {
          setError(err?.message || "שגיאה בטעינת פרטי הפריט");
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [itemId]
  );

  useEffect(() => {
    loadItemData();
  }, [loadItemData]);

  async function handleResolveAlert(alertId: number) {
    if (resolvingAlertId) return;

    try {
      setResolvingAlertId(alertId);
      setError(null);

      await resolveInventoryAlert(alertId);
      await loadItemData({ silent: true });
    } catch (err: any) {
      setError(err?.message || "שגיאה בסגירת ההתראה");
    } finally {
      setResolvingAlertId(null);
    }
  }

  if (loading) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader title="פרטי פריט" />

        <main style={{ maxWidth: "860px", margin: "0 auto", padding: "16px" }}>
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "28px",
              textAlign: "center",
              color: "#6b7280",
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            טוען פרטי פריט...
          </section>
        </main>
      </div>
    );
  }

  if (error && !item) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader title="פרטי פריט" />

        <main style={{ maxWidth: "860px", margin: "0 auto", padding: "16px" }}>
          <section
            style={{
              color: "#991b1b",
              border: "1px solid #fecaca",
              background: "#fef2f2",
              padding: "22px",
              borderRadius: "18px",
              fontSize: "14px",
              textAlign: "center",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: "8px" }}>
              משהו השתבש
            </div>

            <div style={{ marginBottom: "14px" }}>{error}</div>

            <button
              type="button"
              onClick={() => loadItemData()}
              style={{
                minHeight: "42px",
                padding: "10px 16px",
                borderRadius: "12px",
                border: "none",
                background: "#991b1b",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              נסה שוב
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (!item) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader title="פרטי פריט" />

        <main style={{ maxWidth: "860px", margin: "0 auto", padding: "16px" }}>
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "28px",
              textAlign: "center",
              color: "#6b7280",
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            לא נמצאו נתוני פריט
          </section>
        </main>
      </div>
    );
  }

  const safeImageUrl = getSafeImageUrl(item.imageUrl);

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title={item.name} />

      <main
        style={{
          maxWidth: "860px",
          margin: "0 auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {refreshing && (
          <div style={{ fontSize: "13px", color: "#6b7280", textAlign: "center" }}>
            מעדכן נתוני פריט...
          </div>
        )}

        {error && item && (
          <div
            style={{
              color: "#991b1b",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "14px",
              padding: "12px 14px",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "22px",
            background: "#ffffff",
            overflow: "hidden",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
          }}
        >
          <div
            style={{
              padding: "18px 18px 8px 18px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1
                style={{
                  fontSize: "20px",
                  fontWeight: 800,
                  color: "#111827",
                  margin: 0,
                  marginBottom: "4px",
                }}
              >
                {item.name}
              </h1>

              <div style={{ fontSize: "13px", color: "#6b7280" }}>
                כמות נוכחית: {item.currentQuantity}
              </div>
            </div>

            {status && (
              <div
                style={{
                  padding: "6px 12px",
                  borderRadius: "999px",
                  background: status.background,
                  color: status.color,
                  fontSize: "13px",
                  fontWeight: 800,
                }}
              >
                {status.label}
              </div>
            )}
          </div>

          <div style={{ padding: "0 18px 18px 18px" }}>
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
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "18px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
          }}
        >
          <div
            style={{
              fontSize: "16px",
              fontWeight: 800,
              color: "#111827",
              marginBottom: "14px",
            }}
          >
            פרטי פריט
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "12px",
            }}
          >
            <InfoCard label="ברקוד" value={item.barcode || "—"} />
            <InfoCard label="שם ספק" value={item.supplierName || "—"} />
            <InfoCard
              label="יחידת מידה"
              value={UNIT_LABELS[item.unitType] || item.unitType}
            />
            <InfoCard label="כמות נוכחית" value={item.currentQuantity} />
            <InfoCard label="מינימום רצוי" value={item.minimumQuantity} />
            <InfoCard label="נקודת הזמנה" value={item.reorderPoint ?? "—"} />
          </div>
        </section>

        <InventoryMovementForm
          itemId={item.id}
          onSuccess={() => loadItemData({ silent: true })}
        />

        {item.alerts && item.alerts.length > 0 && (
          <section
            style={{
              border: "1px solid #fde68a",
              background: "#fffbeb",
              color: "#92400e",
              borderRadius: "18px",
              padding: "18px",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: "10px", fontSize: "16px" }}>
              התראות פתוחות
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {item.alerts.map((alert) => {
                const alertType = alert.type || alert.alertType;
                const isResolving = resolvingAlertId === alert.id;

                return (
                  <div
                    key={alert.id}
                    style={{
                      borderRadius: "12px",
                      background: "rgba(255,255,255,0.65)",
                      padding: "10px 12px",
                      fontSize: "14px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    <div style={{ lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 800 }}>
                        {getAlertLabel(alertType)}
                      </div>

                      {alert.message && (
                        <div style={{ marginTop: "4px" }}>{alert.message}</div>
                      )}

                      {alert.createdAt && (
                        <div
                          style={{
                            marginTop: "6px",
                            fontSize: "12px",
                            opacity: 0.8,
                          }}
                        >
                          {new Date(alert.createdAt).toLocaleString("he-IL")}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={isResolving || resolvingAlertId !== null}
                      onClick={() => handleResolveAlert(alert.id)}
                      style={{
                        minHeight: "36px",
                        padding: "7px 12px",
                        borderRadius: "10px",
                        border: "1px solid #d1d5db",
                        background: "#ffffff",
                        color: "#111827",
                        cursor:
                          isResolving || resolvingAlertId !== null
                            ? "not-allowed"
                            : "pointer",
                        opacity: isResolving || resolvingAlertId !== null ? 0.65 : 1,
                        fontSize: "12px",
                        fontWeight: 800,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isResolving ? "סוגר..." : "טופל"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "18px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
          }}
        >
          <div
            style={{
              fontSize: "16px",
              fontWeight: 800,
              color: "#111827",
              marginBottom: "14px",
            }}
          >
            היסטוריית תנועות
          </div>

          <InventoryMovementsList movements={movements} />
        </section>
      </main>
    </div>
  );
}