"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { homeCss } from "@/components/inventory/home/home-styles";
import {
  IconCount,
  IconPlus,
  IconReceive,
  IconScan,
  IconTruck,
} from "@/components/inventory/home/home-icons";
import { getStockTone } from "@/components/inventory/inventory-design";
import {
  deriveHomeSummary,
  getAttentionReadout,
  getGreeting,
  selectAttentionItems,
} from "@/components/inventory/home/home-logic";
import { InventoryHero } from "@/components/inventory/home/InventoryHero";
import { StockHealthCard } from "@/components/inventory/home/StockHealthCard";
import { QuickActionsGrid, type QuickAction } from "@/components/inventory/home/QuickActionsGrid";
import { AttentionList } from "@/components/inventory/home/AttentionList";
import { HomeEmpty, HomeError, HomeLoading } from "@/components/inventory/home/HomeStates";

/* Inventory home — screen s8 "Quick Actions home" (modern redesign), per the
   approved mockup `inventory-home-v3-modern`. Structure: header + scan · teal
   hero (stock value) · stock-health bar · quick-actions 2×2 · "דורש טיפול" list.
   Presentation only — the data layer (GET /api/inventory/items), schema and the
   auth/routing are unchanged; all numbers are derived client-side from the items
   payload (see home-logic). The cool canvas + accent palette live as
   inventory-scoped `--inv-home-*` tokens (inventory-tokens.ts). */
export default function InventoryHomePage() {
  const router = useRouter();
  const { t } = useI18n();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function loadItems() {
    try {
      setLoading(true);
      setError(false);
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      // Genuine failure → surface a distinct error state, NEVER an empty-business
      // state. (Previously this did setItems([]) and impersonated a new business.)
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!getClientAuthToken()) redirectToLogin();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadItems();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const summary = useMemo(() => deriveHomeSummary(items), [items]);
  const attentionItems = useMemo(() => selectAttentionItems(items), [items]);
  const greeting = useMemo(() => getGreeting(t), [t]);

  const visibleAttention = showAll ? attentionItems : attentionItems.slice(0, 4);
  const isEmpty = items.length === 0;

  const quickActions: QuickAction[] = [
    { key: "create", label: t("customers.inventory.home.actions.newProduct"), icon: <IconPlus />, tone: "teal", onClick: () => router.push("/inventory/items/create") },
    { key: "count", label: t("customers.inventory.home.actions.count"), icon: <IconCount />, tone: "blue", onClick: () => router.push("/inventory/count") },
    { key: "order", label: t("customers.inventory.home.actions.supplierOrder"), icon: <IconTruck />, tone: "amber", onClick: () => router.push("/inventory/supplier-purchases/new") },
    { key: "receive", label: t("customers.inventory.home.actions.receive"), icon: <IconReceive />, tone: "violet", onClick: () => router.push("/inventory/supplier-purchases/pending") },
  ];

  return (
    <div data-inventory-home data-inventory-module data-page-intent="content">
      <style>{inventoryFoundationCss}</style>
      <style>{homeCss}</style>

      <main className="inv-hm-frame" aria-label={t("customers.inventory.home.ariaLabel")}>
        <header className="inv-hm-head inv-hm-rise" style={{ animationDelay: "0.02s" }}>
          <div>
            <h1>{t("customers.inventory.home.title")}</h1>
            <div className="inv-hm-greet">{greeting} 👋</div>
          </div>
          <button
            type="button"
            className="inv-hm-scan"
            aria-label={t("customers.inventory.home.scanAria")}
            onClick={() => router.push("/inventory/items")}
          >
            <IconScan />
          </button>
        </header>

        {loading ? (
          <HomeLoading />
        ) : error ? (
          <HomeError onRetry={() => void loadItems()} />
        ) : (
          <>
            {isEmpty ? (
              <>
              <InventoryHero stockValue={summary.stockValue} activeCount={summary.activeCount} empty />
              <div className="inv-hm-empty-desk">
                <div>
                  <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.16s" }}>
                    <h2>{t("customers.inventory.home.quickActions")}</h2>
                  </div>
                  <QuickActionsGrid actions={quickActions} />
                </div>
                <div>
                  <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.22s" }}>
                    <h2>{t("customers.inventory.home.yourInventory")}</h2>
                  </div>
                  <HomeEmpty onCreate={() => router.push("/inventory/items/create")} />
                </div>
              </div>
              </>
            ) : (
              <>
                <div className="inv-hm-side">
                  <InventoryHero stockValue={summary.stockValue} activeCount={summary.activeCount} empty={false} />
                  <StockHealthCard
                    okCount={summary.okCount}
                    lowCount={summary.lowCount}
                    criticalCount={summary.criticalCount}
                    total={summary.activeCount}
                    onOk={() => router.push("/inventory/items")}
                    onLow={() => router.push("/inventory/alerts")}
                    onCritical={() => router.push("/inventory/alerts")}
                  />
                  <div className="inv-hm-actions">
                    <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.16s" }}>
                      <h2>{t("customers.inventory.home.quickActions")}</h2>
                    </div>
                    <QuickActionsGrid actions={quickActions} />
                  </div>
                </div>

                <div className="inv-hm-attn">
                <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.22s" }}>
                  <h2>{t("customers.inventory.home.needsAttention")}</h2>
                  {attentionItems.length > 4 ? (
                    <button type="button" className="inv-hm-link" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? t("customers.inventory.home.showLess") : t("customers.inventory.home.showAll")}
                    </button>
                  ) : null}
                </div>

                {attentionItems.length === 0 ? (
                  <div className="inv-hm-note inv-hm-rise" style={{ animationDelay: "0.24s" }}>
                    {t("customers.inventory.home.allGood")}
                  </div>
                ) : (
                  <>
                    <AttentionList items={visibleAttention} onSelect={(id) => router.push(`/inventory/items/${id}`)} />
                    <HomeAttentionDesk
                      items={attentionItems}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      onOpen={(id) => router.push(`/inventory/items/${id}`)}
                    />
                  </>
                )}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function HomeAttentionDesk({
  items,
  selectedId,
  onSelect,
  onOpen,
}: {
  items: InventoryItemDTO[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const { t } = useI18n();
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const readout = selected ? getAttentionReadout(selected) : null;
  const tone = selected ? getStockTone(selected) : null;
  return (
    <div className="inv-hm-attn-desk">
      <div className="inv-hm-attn-table">
        <table>
          <thead>
            <tr>
              <th>{t("customers.inventory.home.table.item")}</th>
              <th>{t("customers.inventory.home.table.state")}</th>
              <th>{t("customers.inventory.home.table.quantity")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const itemTone = getStockTone(item);
              const row = getAttentionReadout(item);
              return (
                <tr
                  key={item.id}
                  className={item.id === selectedId ? "is-selected" : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <td>{item.name}</td>
                  <td>{itemTone === "critical" ? t("customers.inventory.common.critical") : t("customers.inventory.common.low")}</td>
                  <td><bdi>{row.current} / {row.target}</bdi></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <aside className="inv-hm-attn-side">
        {selected && readout ? (
          <>
            <strong>{selected.name}</strong>
            <p style={{ margin: 0, color: "var(--inv-text-muted)", fontSize: 13 }}>
              {tone === "critical" ? t("customers.inventory.home.stockCritical") : t("customers.inventory.home.stockLow")} · <bdi>{t("customers.inventory.home.ofTarget", { current: readout.current, target: readout.target })}</bdi>
            </p>
            <button type="button" className="inv-btn-primary" onClick={() => onOpen(selected.id)}>
              {t("customers.inventory.home.openItem")}
            </button>
          </>
        ) : (
          <p style={{ margin: 0, color: "var(--inv-text-muted)", fontSize: 13 }}>
            {t("customers.inventory.home.selectHint")}
          </p>
        )}
      </aside>
    </div>
  );
}
