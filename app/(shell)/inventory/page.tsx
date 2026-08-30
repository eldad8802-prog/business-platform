"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import {
  deriveHomeSummary,
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
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);

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
  const greeting = useMemo(() => getGreeting(), []);

  const visibleAttention = showAll ? attentionItems : attentionItems.slice(0, 4);
  const isEmpty = items.length === 0;

  const quickActions: QuickAction[] = [
    { key: "create", label: "מוצר חדש", icon: <IconPlus />, tone: "teal", onClick: () => router.push("/inventory/items/create") },
    { key: "count", label: "ספירת מלאי", icon: <IconCount />, tone: "blue", onClick: () => router.push("/inventory/count") },
    { key: "order", label: "הזמנה מספק", icon: <IconTruck />, tone: "amber", onClick: () => router.push("/inventory/supplier-purchases/new") },
    { key: "receive", label: "קבלת סחורה", icon: <IconReceive />, tone: "violet", onClick: () => router.push("/inventory/supplier-purchases/pending") },
  ];

  return (
    <div data-inventory-home data-inventory-module data-page-intent="content" dir="rtl">
      <style>{inventoryFoundationCss}</style>
      <style>{homeCss}</style>

      <main className="inv-hm-frame" aria-label="בית המלאי">
        <header className="inv-hm-head inv-hm-rise" style={{ animationDelay: "0.02s" }}>
          <div>
            <h1>מלאי</h1>
            <div className="inv-hm-greet">{greeting} 👋</div>
          </div>
          <button
            type="button"
            className="inv-hm-scan"
            aria-label="סריקה / חיפוש מוצר"
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
            <InventoryHero stockValue={summary.stockValue} activeCount={summary.activeCount} empty={isEmpty} />

            {isEmpty ? (
              <>
                <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.16s" }}>
                  <h2>פעולות מהירות</h2>
                </div>
                <QuickActionsGrid actions={quickActions} />

                <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.22s" }}>
                  <h2>המלאי שלך</h2>
                </div>
                <HomeEmpty onCreate={() => router.push("/inventory/items/create")} />
              </>
            ) : (
              <>
                <StockHealthCard
                  okCount={summary.okCount}
                  lowCount={summary.lowCount}
                  criticalCount={summary.criticalCount}
                  total={summary.activeCount}
                  onOk={() => router.push("/inventory/items")}
                  onLow={() => router.push("/inventory/alerts")}
                  onCritical={() => router.push("/inventory/alerts")}
                />

                <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.16s" }}>
                  <h2>פעולות מהירות</h2>
                </div>
                <QuickActionsGrid actions={quickActions} />

                <div className="inv-hm-sec inv-hm-rise" style={{ animationDelay: "0.22s" }}>
                  <h2>דורש טיפול</h2>
                  {attentionItems.length > 4 ? (
                    <button type="button" className="inv-hm-link" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? "הצג פחות" : "הצג הכל"}
                    </button>
                  ) : null}
                </div>

                {attentionItems.length === 0 ? (
                  <div className="inv-hm-note inv-hm-rise" style={{ animationDelay: "0.24s" }}>
                    הכול תקין · אין פריטים שדורשים טיפול
                  </div>
                ) : (
                  <AttentionList items={visibleAttention} onSelect={(id) => router.push(`/inventory/items/${id}`)} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
