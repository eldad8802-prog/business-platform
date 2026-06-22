"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { useInventoryInboxCounts } from "@/components/inventory/use-inventory-inbox-counts";
import {
  getStockTone,
  getStockRatio,
  getStockStatusLabel,
  InventorySearch,
  FilterChipRow,
  InventoryProductRow,
  InventoryStatePanel,
  InventorySkeletonBlock,
  IconPlus,
} from "@/components/inventory/inventory-design";
import {
  getInventoryItems,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

type StockTone = ReturnType<typeof getStockTone>;
type ToneFilter = "all" | StockTone;

const UNIT_SHORT: Record<string, string> = {
  UNIT: "יח׳",
  BOX: "מארז",
  KG: "ק״ג",
  GRAM: "גרם",
  LITER: "ליטר",
  ML: "מ״ל",
};

const TONE_DOTS: Record<StockTone, string> = {
  critical: "#ef4444",
  low: "#f59e0b",
  ok: "#22c55e",
};

function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}

function itemMeta(item: InventoryItemDTO) {
  return [item.category?.name, item.supplierName, item.sku]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .join(" · ");
}

/** Caption under the stock bar, mirroring the mockup's `.barcap` copy. */
function itemCaption(item: InventoryItemDTO): string | undefined {
  if (item.reorderPoint != null) {
    return `${item.currentQuantity} מתוך סף הזמנה ${item.reorderPoint}`;
  }
  if (item.minimumQuantity > 0) {
    return `${item.currentQuantity} · סף מינימום ${item.minimumQuantity}`;
  }
  return undefined;
}

function InventoryItemsListPageContent() {
  const searchParams = useSearchParams();
  const { counts: inboxCounts } = useInventoryInboxCounts();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const statusParam = searchParams.get("status") || "";
  const missingDataMode = statusParam === "missing-data";
  const [toneFilter, setToneFilter] = useState<ToneFilter>(
    statusParam === "low" ? "low" : "all"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sortedItems = useMemo(() => {
    const toneOrder: Record<StockTone, number> = { critical: 0, low: 1, ok: 2 };
    return [...items].sort((a, b) => {
      const ta = toneOrder[getStockTone(a)];
      const tb = toneOrder[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
  }, [items]);

  const counts = useMemo(
    () =>
      sortedItems.reduce(
        (acc, item) => {
          acc[getStockTone(item)] += 1;
          return acc;
        },
        { critical: 0, low: 0, ok: 0 } as Record<StockTone, number>
      ),
    [sortedItems]
  );

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    return sortedItems.filter((item) => {
      if (missingDataMode) {
        const hasCost = item.costPerUnit != null || item.lastPurchaseCost != null;
        if (hasCost && item.sellPricePerUnit != null) return false;
      } else if (toneFilter !== "all" && getStockTone(item) !== toneFilter) {
        return false;
      }
      if (!value) return true;
      return [item.name, item.barcode, item.sku, item.supplierName, item.category?.name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value));
    });
  }, [missingDataMode, query, sortedItems, toneFilter]);

  const attention = counts.critical + counts.low;

  async function loadItems() {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const itemsData = await getInventoryItems();
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת המוצרים");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const sub = (
    <>
      {items.length} מוצרים
      {attention > 0 ? <> · <b>{attention} דורשים טיפול</b></> : <> · הכול תקין</>}
    </>
  );

  return (
    <InventorySubPage
      title="מלאי"
      variant="hub"
      sub={!loading && !error ? sub : undefined}
      headerAction={{
        icon: <IconPlus />,
        label: "מוצר חדש",
        href: "/inventory/items/create",
        accent: true,
      }}
      bottomNav="products"
    >
      <InventorySearch
        value={query}
        onChange={setQuery}
        placeholder="חיפוש לפי שם, מק״ט או ברקוד"
      />

      {missingDataMode ? (
        <div className="inv-hd__sub" style={{ marginTop: 14 }}>
          מוצרים עם נתונים חסרים — עלות או מחיר מכירה
        </div>
      ) : (
        <FilterChipRow<ToneFilter>
          value={toneFilter}
          onChange={setToneFilter}
          options={[
            { value: "all", label: "הכל" },
            { value: "critical", label: "קריטי", dotColor: TONE_DOTS.critical },
            { value: "low", label: "נמוך", dotColor: TONE_DOTS.low },
            { value: "ok", label: "תקין", dotColor: TONE_DOTS.ok },
          ]}
        />
      )}

      {!loading && !error && inboxCounts.drafts > 0 ? (
        <div
          style={{
            width: "100%",
            maxWidth: "var(--inv-content-max, 720px)",
            margin: "12px auto 0",
            padding: "0 clamp(16px,3.5vw,28px)",
            boxSizing: "border-box",
          }}
        >
          <Link
            href="/inventory/drafts"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
              background: "var(--inv-card-bg)",
              border: "1px solid var(--inv-border)",
              borderRadius: "var(--inv-radius-md)",
              boxShadow: "var(--inv-shadow)",
              padding: "12px 14px",
              color: "var(--inv-text)",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <span style={{ fontSize: 20 }} aria-hidden>🗂️</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <bdi>{inboxCounts.drafts}</bdi> מוצרים זוהו אוטומטית · ממתינים לאישור
            </span>
            <span style={{ color: "var(--inv-accent)", fontWeight: 800, flexShrink: 0 }}>אישור ›</span>
          </Link>
        </div>
      ) : null}

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title="משהו השתבש"
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadItems()}>
                נסה שוב
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={80} rows={5} />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={items.length === 0 ? "עדיין אין מוצרים במלאי" : "לא נמצאו מוצרים"}
          >
            {items.length === 0
              ? "הוסיפו מוצר ראשון כדי להתחיל לעקוב אחרי הכמויות, הספים וההתראות."
              : "נסו חיפוש קצר יותר או שנו את הסינון."}
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {filteredItems.map((item) => {
            const tone = getStockTone(item);
            return (
              <InventoryProductRow
                key={item.id}
                tone={tone}
                imageUrl={safeImage(item.imageUrl)}
                thumbGlyph={
                  <span aria-hidden style={{ fontSize: 26, lineHeight: 1 }}>
                    {getProductEmoji(item.name, item.category?.name)}
                  </span>
                }
                name={item.name}
                meta={itemMeta(item) || undefined}
                ratio={getStockRatio(item)}
                caption={itemCaption(item)}
                statusLabel={getStockStatusLabel(tone)}
                quantity={item.currentQuantity}
                unitLabel={UNIT_SHORT[item.unitType] ?? undefined}
                href={`/inventory/items/${item.id}`}
              />
            );
          })}
        </div>
      )}
    </InventorySubPage>
  );
}

// useSearchParams() requires a Suspense boundary for static prerender (Next).
export default function InventoryItemsListPage() {
  return (
    <Suspense fallback={null}>
      <InventoryItemsListPageContent />
    </Suspense>
  );
}
