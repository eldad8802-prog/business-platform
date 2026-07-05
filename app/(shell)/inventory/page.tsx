"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  getStockTone,
  getStockRatio,
  getStockStatusLabel,
  InventoryProductRow,
  stockPalette,
} from "@/components/inventory/inventory-design";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { inventoryPrimitivesCss } from "@/components/inventory/inventory-primitives.css";
import { inventoryToneStyles } from "@/components/inventory/inventory-tokens";
import { getProductEmoji } from "@/lib/inventory/product-emoji";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

const UNIT_SHORT: Record<string, string> = { UNIT: "יח׳", BOX: "מארז", KG: "ק״ג", GRAM: "גרם", LITER: "ליטר", ML: "מ״ל" };

const valueFormatter = new Intl.NumberFormat("he-IL", {
  notation: "compact",
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 1,
});

/* Home — screen s8 (Quick Actions home) per docs/design/inventory/inventory_screens.html.txt.
   Supersedes the Operations Workspace home (see docs/inventory-home-screen-lock-v3.md → override note).
   Structure: header + scan · greeting · 3 status tiles · quick-actions grid · "דורש טיפול" list.
   All numbers come from real data (getInventoryItems / getStockTone); brand color from --inv tokens
   (navy), status tiles from stockPalette. No hardcoded #0f6fff. UI only — no schema/API/logic change. */
const homeCss = `
[data-inventory-home] { background: var(--inv-page-bg); min-height: 100vh; min-height: 100dvh; direction: rtl; color: var(--inv-text); }
[data-inventory-home] .inv-hm { width: 100%; max-width: 560px; margin: 0 auto; padding: 14px clamp(16px,4vw,20px) 48px; box-sizing: border-box; }

[data-inventory-home] .inv-hm-head { display: flex; align-items: center; gap: 12px; padding: 8px 0 2px; }
[data-inventory-home] .inv-hm-head h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.4px; }
[data-inventory-home] .inv-hm-grow { flex: 1; }
[data-inventory-home] .inv-hm-scan { width: 42px; height: 42px; border-radius: 50%; border: 0; background: var(--inv-primary); color: var(--inv-on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--inv-shadow); }
[data-inventory-home] .inv-hm-greet { font-size: 14px; font-weight: 600; color: var(--inv-text-muted); padding: 0 2px; margin-top: -2px; }

[data-inventory-home] .inv-hm-tiles { display: flex; gap: 11px; padding: 16px 0 4px; }
[data-inventory-home] .inv-hm-tile { flex: 1; min-width: 0; border: 0; border-radius: 14px; padding: 13px 14px; text-align: start; cursor: pointer; font-family: inherit; display: flex; flex-direction: column; align-items: flex-start; }
[data-inventory-home] .inv-hm-tile__n { font-size: 23px; font-weight: 600; line-height: 1; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }
[data-inventory-home] .inv-hm-tile__l { font-size: 12.5px; font-weight: 600; margin-top: 5px; }

[data-inventory-home] .inv-hm-sechead { display: flex; align-items: center; justify-content: space-between; padding: 22px 2px 11px; }
[data-inventory-home] .inv-hm-sechead h2 { margin: 0; font-size: 19px; font-weight: 600; }
[data-inventory-home] .inv-hm-sechead a { font-size: 13.5px; font-weight: 600; color: var(--inv-accent); cursor: pointer; }

[data-inventory-home] .inv-hm-qgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
[data-inventory-home] .inv-hm-qtile { border: 0; border-radius: 14px; background: var(--inv-surface-2); padding: 15px; display: flex; align-items: center; justify-content: flex-start; gap: 12px; cursor: pointer; font-family: inherit; transition: background 120ms ease; }
[data-inventory-home] .inv-hm-qtile:hover { background: var(--inv-border); }
[data-inventory-home] .inv-hm-qtile__t { font-size: 15.5px; font-weight: 600; color: var(--inv-text); }
[data-inventory-home] .inv-hm-qtile__i { width: 44px; height: 44px; border-radius: 12px; background: var(--inv-card-bg); box-shadow: var(--inv-shadow); display: inline-flex; align-items: center; justify-content: center; color: var(--inv-accent); flex-shrink: 0; }

[data-inventory-home] .inv-hm-empty { padding: 20px 12px; text-align: center; color: var(--inv-text-muted); font-size: 14px; font-weight: 400; border: 1px solid var(--inv-border); border-radius: var(--inv-radius-lg); background: var(--inv-card-bg); }
`;

export default function InventoryHomePage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [showAll, setShowAll] = useState(false);
  async function loadItems() {
    try {
      setLoadingItems(true);
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) return redirectToLogin();
      setItems([]);
    } finally {
      setLoadingItems(false);
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

  const sortedItems = useMemo(() => {
    const order: Record<string, number> = { critical: 0, low: 1, ok: 2 };
    return [...items].sort((a, b) => {
      const ta = order[getStockTone(a)];
      const tb = order[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
  }, [items]);

  // Status tiles — derived from real items, never inbox-only fakes.
  const { criticalCount, lowCount, stockValue } = useMemo(() => {
    let critical = 0;
    let low = 0;
    let value = 0;
    for (const it of items) {
      const tone = getStockTone(it);
      if (tone === "critical") critical += 1;
      else if (tone === "low") low += 1;
      const unitCost = it.costPerUnit ?? it.lastPurchaseCost ?? 0;
      value += it.currentQuantity * unitCost;
    }
    return { criticalCount: critical, lowCount: low, stockValue: value };
  }, [items]);

  const attentionItems = useMemo(
    () => sortedItems.filter((i) => getStockTone(i) !== "ok"),
    [sortedItems],
  );
  const visibleAttention = showAll ? attentionItems : attentionItems.slice(0, 4);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "בוקר טוב 👋";
    if (h < 18) return "צהריים טובים 👋";
    return "ערב טוב 👋";
  }, []);

  const crit = stockPalette("critical");
  const lowPal = stockPalette("low");
  // When a status count is 0 there is nothing wrong — show a calm neutral tile
  // instead of a red/amber one, so an empty state never reads as a false alert.
  const neutralBg = "var(--inv-surface-2)";
  const neutralInk = "var(--inv-text-muted)";

  const tiles = [
    {
      n: String(criticalCount),
      l: "מלאי קריטי",
      bg: criticalCount > 0 ? crit.bg : neutralBg,
      ink: criticalCount > 0 ? crit.ink : neutralInk,
      onClick: () => router.push("/inventory/alerts"),
    },
    {
      n: String(lowCount),
      l: "מלאי נמוך",
      bg: lowCount > 0 ? lowPal.bg : neutralBg,
      ink: lowCount > 0 ? lowPal.ink : neutralInk,
      onClick: () => router.push("/inventory/alerts"),
    },
    { n: valueFormatter.format(Math.round(stockValue)), l: "שווי מלאי", bg: inventoryToneStyles.info.bg, ink: inventoryToneStyles.info.color, onClick: () => router.push("/inventory/items") },
  ];

  const quickActions: Array<{ t: string; icon: ReactNode; onClick: () => void }> = [
    { t: "מוצר חדש", icon: <IconPlus />, onClick: () => router.push("/inventory/items/create") },
    { t: "ספירת מלאי", icon: <IconClipboard />, onClick: () => router.push("/inventory/items") },
    { t: "הזמנה מספק", icon: <IconTruck />, onClick: () => router.push("/inventory/supplier-purchases/new") },
    { t: "קבלת סחורה", icon: <IconReceive />, onClick: () => router.push("/inventory/supplier-purchases/pending") },
  ];

  return (
    <div data-inventory-home data-inventory-module>
      <style>{inventoryFoundationCss}</style>
      <style>{inventoryPrimitivesCss}</style>
      <style>{homeCss}</style>

      <main className="inv-hm" aria-label="בית המלאי">
        <header className="inv-hm-head">
          <h1>מלאי</h1>
          <span className="inv-hm-grow" />
          <button type="button" className="inv-hm-scan" aria-label="סריקה / חיפוש מוצר" onClick={() => router.push("/inventory/items")}>
            <IconScan />
          </button>
        </header>
        <div className="inv-hm-greet">{greeting}</div>

        <div className="inv-hm-tiles">
          {tiles.map((tile) => (
            <button key={tile.l} type="button" className="inv-hm-tile" style={{ background: tile.bg }} onClick={tile.onClick}>
              <span className="inv-hm-tile__n" style={{ color: tile.ink }}><bdi>{tile.n}</bdi></span>
              <span className="inv-hm-tile__l" style={{ color: tile.ink }}>{tile.l}</span>
            </button>
          ))}
        </div>

        <div className="inv-hm-sechead">
          <h2>פעולות מהירות</h2>
        </div>
        <div className="inv-hm-qgrid">
          {quickActions.map((qa) => (
            <button key={qa.t} type="button" className="inv-hm-qtile" onClick={qa.onClick}>
              <span className="inv-hm-qtile__i" aria-hidden>{qa.icon}</span>
              <span className="inv-hm-qtile__t">{qa.t}</span>
            </button>
          ))}
        </div>

        <div className="inv-hm-sechead">
          <h2>דורש טיפול</h2>
          {attentionItems.length > 4 ? (
            <a role="button" tabIndex={0} onClick={() => setShowAll((v) => !v)} onKeyDown={(e) => { if (e.key === "Enter") setShowAll((v) => !v); }}>
              {showAll ? "הצג פחות" : "הצג הכל ›"}
            </a>
          ) : null}
        </div>

        {loadingItems ? (
          <div className="inv-rows" style={{ padding: 0 }}>
            <InventorySkeleton />
          </div>
        ) : attentionItems.length === 0 ? (
          <div className="inv-hm-empty">{items.length === 0 ? "אין עדיין מוצרים במלאי" : "הכול תקין · אין פריטים שדורשים טיפול"}</div>
        ) : (
          <div className="inv-rows" style={{ padding: 0 }}>
            {visibleAttention.map((item) => {
              const tone = getStockTone(item);
              return (
                <InventoryProductRow
                  key={item.id}
                  tone={tone}
                  imageUrl={item.imageUrl && !item.imageUrl.includes("example.com") ? item.imageUrl : null}
                  thumbGlyph={<span style={{ fontSize: 26 }}>{getProductEmoji(item.name, item.category?.name)}</span>}
                  name={item.name}
                  meta={[item.category?.name, item.supplierName].filter(Boolean).join(" · ") || undefined}
                  ratio={getStockRatio(item)}
                  statusLabel={getStockStatusLabel(tone)}
                  quantity={item.currentQuantity}
                  unitLabel={UNIT_SHORT[item.unitType] ?? undefined}
                  href={`/inventory/items/${item.id}`}
                />
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function InventorySkeleton() {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="inv-skeleton-block" style={{ height: 72, borderRadius: 14, background: "linear-gradient(90deg, rgba(246,236,221,0.65), rgba(253,244,235,0.92), rgba(246,236,221,0.65))", backgroundSize: "220% 100%" }} />
      ))}
    </div>
  );
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>{children}</svg>;
}
function IconScan() { return <Svg size={22}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></Svg>; }
function IconPlus() { return <Svg><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></Svg>; }
function IconClipboard() { return <Svg><rect x="5" y="3" width="14" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.9" /><path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></Svg>; }
function IconTruck() { return <Svg><path d="M2 7h11v9H2zM13 10h4l3 3v3h-7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><circle cx="6" cy="18.5" r="1.6" stroke="currentColor" strokeWidth="1.8" /><circle cx="17" cy="18.5" r="1.6" stroke="currentColor" strokeWidth="1.8" /></Svg>; }
function IconReceive() { return <Svg><path d="M3 9h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z" stroke="currentColor" strokeWidth="1.8" /><path d="M3 9 5 4h14l2 5M9 14h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></Svg>; }
