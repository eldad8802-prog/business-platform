"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  FilterChipRow,
  InventoryRow,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
  IconPlus,
  type BadgeTone,
} from "@/components/inventory/inventory-design";
import { buildClientAuthHeaders } from "@/lib/client-session";

type PurchaseOrderLine = {
  id: number;
  orderedQty: number;
  unitCost: number | null;
};

type PurchaseOrder = {
  id: number;
  supplierName: string | null;
  externalOrderId: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  lines: PurchaseOrderLine[];
};

type Tab = "pending" | "transit" | "history";

const STATUS_GROUP: Record<Tab, string[]> = {
  pending: ["DRAFT", "CONFIRMED"],
  transit: ["SENT", "AWAITING_DELIVERY"],
  history: ["CLOSED", "CANCELLED"],
};

const STATUS_BADGE: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "טיוטה", tone: "neutral" },
  CONFIRMED: { label: "מאושרת", tone: "info" },
  SENT: { label: "נשלחה", tone: "info" },
  AWAITING_DELIVERY: { label: "בהמתנה לאספקה", tone: "low" },
  CLOSED: { label: "נסגרה", tone: "ok" },
  CANCELLED: { label: "בוטלה", tone: "neutral" },
};

function formatDate(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (sameDay(d, today)) return "היום";
  if (sameDay(d, yesterday)) return "אתמול";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

function orderTotal(order: PurchaseOrder): number {
  return order.lines.reduce((sum, line) => sum + line.orderedQty * (line.unitCost ?? 0), 0);
}

export default function SupplierPurchasesHubPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch("/api/inventory/purchase-orders", {
          headers: buildClientAuthHeaders(),
          cache: "no-store",
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "Failed to load purchase orders");
        if (isMounted) setOrders(Array.isArray(data?.purchaseOrders) ? data.purchaseOrders : []);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את ההזמנות");
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, []);

  const groupCounts = useMemo(() => {
    const counts: Record<Tab, number> = { pending: 0, transit: 0, history: 0 };
    for (const order of orders) {
      (Object.keys(STATUS_GROUP) as Tab[]).forEach((t) => {
        if (STATUS_GROUP[t].includes(order.status)) counts[t] += 1;
      });
    }
    return counts;
  }, [orders]);

  const visibleOrders = useMemo(
    () => orders.filter((order) => STATUS_GROUP[tab].includes(order.status)),
    [orders, tab]
  );

  const sub = (
    <>
      {groupCounts.pending} ממתינות · {groupCounts.transit} בדרך
    </>
  );

  return (
    <InventorySubPage intent="data"
      title="רכש מספקים"
      variant="hub"
      sub={!loading && !error ? sub : undefined}
      headerAction={{
        icon: <IconPlus />,
        label: "הזמנה חדשה",
        href: "/inventory/supplier-purchases/new",
        accent: true,
      }}
      bottomNav="orders"
    >
      <FilterChipRow<Tab | "import">
        value={tab}
        onChange={(value) => {
          if (value === "import") {
            router.push("/inventory/supplier-purchases/import");
            return;
          }
          setTab(value);
        }}
        options={[
          { value: "pending", label: "ממתינות" },
          { value: "transit", label: "בדרך" },
          { value: "history", label: "היסטוריה" },
          { value: "import", label: "יבוא" },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="משהו השתבש">{error}</InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={74} rows={4} />
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={
              tab === "pending"
                ? "אין הזמנות פתוחות"
                : tab === "transit"
                  ? "אין הזמנות בדרך"
                  : "אין היסטוריית הזמנות"
            }
            action={
              <button
                type="button"
                className="inv-btn-primary inv-btn-primary--full"
                onClick={() => router.push("/inventory/supplier-purchases/new")}
              >
                יצירת הזמנה חדשה
              </button>
            }
          >
            יצירת הזמנה לא משנה מלאי — קליטת הסחורה היא הפעולה שמעדכנת אותו.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {visibleOrders.map((order) => {
            const badge = STATUS_BADGE[order.status] ?? { label: order.status, tone: "neutral" as BadgeTone };
            const idLabel = order.externalOrderId ? `#${order.externalOrderId}` : `#${order.id}`;
            const total = orderTotal(order);
            const date = formatDate(order.orderDate ?? order.createdAt);
            const metaParts: string[] = [
              `${order.lines.length} פריטים`,
              total > 0 ? `₪${total.toLocaleString("he-IL")}` : "",
              date || "",
            ].filter(Boolean);
            const canReceive = order.status === "AWAITING_DELIVERY";
            return (
              <InventoryRow
                key={order.id}
                thumb={<span style={{ fontSize: 26 }} aria-hidden>🚚</span>}
                thumbBg="var(--inv-surface)"
                title={
                  <>
                    <bdi>{order.supplierName || "הזמנה ללא ספק"}</bdi>
                    {" · "}
                    <bdi>{idLabel}</bdi>
                  </>
                }
                meta={metaParts.map((part, i) => (
                  <span key={i}>
                    {i > 0 ? " · " : null}
                    <bdi>{part}</bdi>
                  </span>
                ))}
                trail={
                  <>
                    <InventoryBadge tone={badge.tone}>{badge.label}</InventoryBadge>
                    {canReceive ? (
                      <button
                        type="button"
                        className="inv-row__action"
                        onClick={() => router.push(`/inventory/supplier-purchases/${order.id}/receive`)}
                      >
                        קבל סחורה ›
                      </button>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </InventorySubPage>
  );
}
