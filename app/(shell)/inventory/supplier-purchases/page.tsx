"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

type PurchaseOrderLine = {
  id: number;
  orderedQty: number;
  unitCost: number | null;
  /** Server-computed; the API has always returned these alongside each line. */
  receivedQty?: number;
  openQty?: number;
};

type PurchaseOrder = {
  id: number;
  supplierId: number | null;
  supplierName: string | null;
  externalOrderId: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  lines: PurchaseOrderLine[];
};

/**
 * Is there anything left to receive against this order?
 *
 * Reads the server's own `openQty` (ordered − posted receipts − closed-short)
 * and falls back to the ordered quantity only when the field is absent. This is
 * what decides whether the receiving screen is offered — previously the offer
 * was gated on status === "AWAITING_DELIVERY", a state nothing ever produced, so
 * the receiving screen was unreachable from the normal flow.
 */
function hasOpenQuantity(order: PurchaseOrder): boolean {
  if (order.status === "CLOSED" || order.status === "CANCELLED") return false;
  return order.lines.some((line) =>
    line.openQty != null ? line.openQty > 0 : line.orderedQty > 0
  );
}

type Tab = "pending" | "transit" | "history";

const STATUS_GROUP: Record<Tab, string[]> = {
  pending: ["DRAFT", "CONFIRMED"],
  transit: ["SENT", "AWAITING_DELIVERY"],
  history: ["CLOSED", "CANCELLED"],
};

const STATUS_BADGE: Record<string, { label: MessageKey; tone: BadgeTone }> = {
  DRAFT: { label: "customers.purchases.status.DRAFT", tone: "neutral" },
  CONFIRMED: { label: "customers.purchases.status.CONFIRMED", tone: "info" },
  SENT: { label: "customers.purchases.status.SENT", tone: "info" },
  AWAITING_DELIVERY: { label: "customers.purchases.status.AWAITING_DELIVERY", tone: "low" },
  CLOSED: { label: "customers.purchases.status.CLOSED", tone: "ok" },
  CANCELLED: { label: "customers.purchases.status.CANCELLED", tone: "neutral" },
};

function statusBadge(status: string, t: Translator): { label: string; tone: BadgeTone } {
  const entry = STATUS_BADGE[status];
  return entry ? { label: t(entry.label), tone: entry.tone } : { label: status, tone: "neutral" };
}

function formatDate(value: string | null, t: Translator, locale: Locale): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (sameDay(d, today)) return t("customers.purchases.hub.today");
  if (sameDay(d, yesterday)) return t("customers.purchases.hub.yesterday");
  return d.toLocaleDateString(intlTag(locale), { day: "numeric", month: "numeric" });
}

function PurchaseInspector({
  order,
  onReceive,
  onSupplier,
}: {
  order: PurchaseOrder | null;
  onReceive: (id: number) => void;
  onSupplier: (id: number) => void;
}) {
  const { t, locale } = useI18n();
  if (!order) {
    return (
      <aside className="inv-ops__side">
        <h2>{t("customers.purchases.hub.inspector.title")}</h2>
        <p>{t("customers.purchases.hub.inspector.empty")}</p>
      </aside>
    );
  }
  const badge = statusBadge(order.status, t);
  const total = orderTotal(order);
  return (
    <aside className="inv-ops__side">
      <h2>{order.supplierName || t("customers.purchases.common.noSupplierOrder")}</h2>
      <p>{badge.label} · {order.externalOrderId ? `#${order.externalOrderId}` : `#${order.id}`}</p>
      <p>
        {t(
          order.lines.length === 1 ? "customers.purchases.hub.inspector.linesOne" : "customers.purchases.hub.inspector.linesMany",
          { count: order.lines.length }
        )}
        {total > 0 ? ` · ₪${total.toLocaleString(intlTag(locale))}` : ""}
      </p>
      {order.lines.slice(0, 6).map((line) => (
        <p key={line.id}>
          {t("customers.purchases.hub.inspector.qty", { qty: line.orderedQty })}
          {line.openQty != null ? ` · ${t("customers.purchases.hub.inspector.open", { qty: line.openQty })}` : ""}
        </p>
      ))}
      {order.supplierId != null ? (
        <button type="button" className="inv-btn-secondary" onClick={() => onSupplier(order.supplierId!)}>{t("customers.purchases.hub.inspector.supplierCard")}</button>
      ) : null}
      {hasOpenQuantity(order) ? (
        <button type="button" className="inv-btn-primary" onClick={() => onReceive(order.id)}>{t("customers.purchases.hub.receive")}</button>
      ) : (
        <p>{t("customers.purchases.hub.inspector.nothingOpen")}</p>
      )}
    </aside>
  );
}

function orderTotal(order: PurchaseOrder): number {
  return order.lines.reduce((sum, line) => sum + line.orderedQty * (line.unitCost ?? 0), 0);
}

export default function SupplierPurchasesHubPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);

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
        if (isMounted) setError(err instanceof Error ? err.message : t("customers.purchases.hub.loadError"));
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, [t]);

  const groupCounts = useMemo(() => {
    const counts: Record<Tab, number> = { pending: 0, transit: 0, history: 0 };
    for (const order of orders) {
      (Object.keys(STATUS_GROUP) as Tab[]).forEach((group) => {
        if (STATUS_GROUP[group].includes(order.status)) counts[group] += 1;
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
      {t("customers.purchases.hub.subPending", { count: groupCounts.pending })} ·{" "}
      {t("customers.purchases.hub.subTransit", { count: groupCounts.transit })}
    </>
  );

  return (
    <InventorySubPage intent="data"
      title={t("customers.purchases.hub.title")}
      variant="hub"
      sub={!loading && !error ? sub : undefined}
      headerAction={{
        icon: <IconPlus />,
        label: t("customers.purchases.hub.newOrder"),
        href: "/inventory/supplier-purchases/new",
        accent: true,
      }}
      bottomNav="orders"
    >
      <div
        className="inv-page-content"
        style={{ padding: "0 clamp(16px,3.5vw,28px)", marginBottom: 4 }}
      >
        <Link className="inv-btn-link" href="/suppliers">
          {t("customers.purchases.hub.supplierCardsLink")}
        </Link>
      </div>

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
          { value: "pending", label: t("customers.purchases.hub.tabs.pending") },
          { value: "transit", label: t("customers.purchases.hub.tabs.transit") },
          { value: "history", label: t("customers.purchases.hub.tabs.history") },
          { value: "import", label: t("customers.purchases.hub.tabs.import") },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={t("customers.purchases.common.somethingWrong")}>{error}</InventoryStatePanel>
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
                ? t("customers.purchases.hub.empty.pending")
                : tab === "transit"
                  ? t("customers.purchases.hub.empty.transit")
                  : t("customers.purchases.hub.empty.history")
            }
            action={
              <button
                type="button"
                className="inv-btn-primary inv-btn-primary--full"
                onClick={() => router.push("/inventory/supplier-purchases/new")}
              >
                {t("customers.purchases.hub.empty.create")}
              </button>
            }
          >
            {t("customers.purchases.hub.empty.body")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label={t("customers.purchases.hub.tableAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.purchases.hub.cols.supplier")}</th>
                <th>{t("customers.purchases.hub.cols.order")}</th>
                <th>{t("customers.purchases.hub.cols.items")}</th>
                <th>{t("customers.purchases.hub.cols.amount")}</th>
                <th>{t("customers.purchases.hub.cols.date")}</th>
                <th>{t("customers.purchases.hub.cols.status")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const badge = statusBadge(order.status, t);
                const total = orderTotal(order);
                return (
                  <tr
                    key={order.id}
                    className={order.id === selectedId ? "is-selected" : undefined}
                    onClick={() => setSelectedId(order.id)}
                  >
                    <td>{order.supplierName || t("customers.purchases.common.noSupplierOrder")}</td>
                    <td className="num">{order.externalOrderId ? `#${order.externalOrderId}` : `#${order.id}`}</td>
                    <td className="num">{order.lines.length}</td>
                    <td className="num">{total > 0 ? `₪${total.toLocaleString(intlTag(locale))}` : "—"}</td>
                    <td className="num">{formatDate(order.orderDate ?? order.createdAt, t, locale) || "—"}</td>
                    <td>{badge.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <PurchaseInspector
          order={visibleOrders.find((order) => order.id === selectedId) ?? null}
          onReceive={(id) => router.push(`/inventory/supplier-purchases/${id}/receive`)}
          onSupplier={(id) => router.push(`/suppliers/${id}`)}
        />
        </div>
        <div className="inv-rows inv-cards">
          {visibleOrders.map((order) => {
            const badge = statusBadge(order.status, t);
            const idLabel = order.externalOrderId ? `#${order.externalOrderId}` : `#${order.id}`;
            const total = orderTotal(order);
            const date = formatDate(order.orderDate ?? order.createdAt, t, locale);
            const metaParts: string[] = [
              t(
                order.lines.length === 1 ? "customers.purchases.common.itemsOne" : "customers.purchases.common.itemsMany",
                { count: order.lines.length }
              ),
              total > 0 ? `₪${total.toLocaleString(intlTag(locale))}` : "",
              date || "",
            ].filter(Boolean);
            const canReceive = hasOpenQuantity(order);
            return (
              <InventoryRow
                key={order.id}
                thumb={<span style={{ fontSize: 26 }} aria-hidden>🚚</span>}
                thumbBg="var(--inv-surface)"
                title={
                  <>
                    {order.supplierId != null ? (
                      // One domain, two surfaces: an order that knows its
                      // supplier entity links straight to that supplier's card.
                      <a
                        href={`/suppliers/${order.supplierId}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: "inherit" }}
                      >
                        <bdi>{order.supplierName || t("customers.purchases.common.supplierFallback")}</bdi>
                      </a>
                    ) : (
                      <bdi>{order.supplierName || t("customers.purchases.common.noSupplierOrder")}</bdi>
                    )}
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
                        {t("customers.purchases.hub.receiveArrow")}
                      </button>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </div>
        </>
      )}
    </InventorySubPage>
  );
}
