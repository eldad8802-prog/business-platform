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

import {
  derivePurchaseOrderDisplayState,
  purchaseOrderDisplayBucket,
  isReceivableDisplayState,
  type PoDisplayState,
} from "@/lib/services/inventory/purchase-order-display";

type PurchaseOrderLine = {
  id: number;
  orderedQty: number;
  unitCost: number | null;
  // Ledger-derived quantities (from withPurchaseOrderLineQuantities); drive the
  // derived display state instead of the dead SENT/AWAITING_DELIVERY/CLOSED status.
  receivedQty?: number;
  closedShortQty?: number;
  openQty?: number;
};

type PurchaseOrder = {
  id: number;
  supplierName: string | null;
  externalOrderId: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  // Phase D — share event metadata (SENT retired as a status).
  sharedAt: string | null;
  lines: PurchaseOrderLine[];
};

type Tab = "pending" | "transit" | "history";

// Badge is keyed on the DERIVED display state, not the stored status.
const STATE_BADGE: Record<PoDisplayState, { label: string; tone: BadgeTone }> = {
  OPEN: { label: "פתוחה", tone: "info" },
  SHARED: { label: "נשלחה לספק", tone: "info" },
  PARTIAL: { label: "התקבלה חלקית", tone: "low" },
  RECEIVED: { label: "התקבלה", tone: "ok" },
  CLOSED: { label: "נסגרה", tone: "ok" },
  CANCELLED: { label: "בוטלה", tone: "neutral" },
};

function orderTotals(order: PurchaseOrder) {
  return order.lines.reduce(
    (acc, line) => {
      const received = line.receivedQty ?? 0;
      const closedShort = line.closedShortQty ?? 0;
      acc.orderedQty += line.orderedQty;
      acc.receivedQty += received;
      acc.closedShortQty += closedShort;
      acc.openQty += line.openQty ?? line.orderedQty - received - closedShort;
      return acc;
    },
    { orderedQty: 0, receivedQty: 0, closedShortQty: 0, openQty: 0 }
  );
}

function orderDisplayState(order: PurchaseOrder): PoDisplayState {
  const totals = orderTotals(order);
  return derivePurchaseOrderDisplayState({
    status: order.status,
    orderedQty: totals.orderedQty,
    receivedQty: totals.receivedQty,
    closedShortQty: totals.closedShortQty,
    openQty: totals.openQty,
    sharedAt: order.sharedAt,
  });
}

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

  const decorated = useMemo(
    () =>
      orders.map((order) => {
        const state = orderDisplayState(order);
        return { order, state, bucket: purchaseOrderDisplayBucket(state) };
      }),
    [orders]
  );

  const groupCounts = useMemo(() => {
    const counts: Record<Tab, number> = { pending: 0, transit: 0, history: 0 };
    for (const d of decorated) counts[d.bucket] += 1;
    return counts;
  }, [decorated]);

  const visibleOrders = useMemo(
    () => decorated.filter((d) => d.bucket === tab),
    [decorated, tab]
  );

  const sub = (
    <>
      {groupCounts.pending} ממתינות · {groupCounts.transit} בדרך
    </>
  );

  return (
    <InventorySubPage
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
          {visibleOrders.map(({ order, state }) => {
            const badge = STATE_BADGE[state];
            const idLabel = order.externalOrderId ? `#${order.externalOrderId}` : `#${order.id}`;
            const total = orderTotal(order);
            const date = formatDate(order.orderDate ?? order.createdAt);
            const metaParts: string[] = [
              `${order.lines.length} פריטים`,
              total > 0 ? `₪${total.toLocaleString("he-IL")}` : "",
              date || "",
            ].filter(Boolean);
            // Phase C/D — receive-eligibility is DERIVED from the ledger (display
            // state), not the dead AWAITING_DELIVERY status. A PO created via
            // approve COMMIT_ONLY (CONFIRMED, openQty > 0) is now receivable.
            const canReceive = isReceivableDisplayState(state);
            return (
              <InventoryRow
                key={order.id}
                thumb={<span style={{ fontSize: 26 }} aria-hidden>🚚</span>}
                thumbBg="var(--inv-surface, #f5f7f9)"
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
