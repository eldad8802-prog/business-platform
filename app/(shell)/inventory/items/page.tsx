"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { getStockTone } from "@/components/inventory/inventory-design";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";

type StockTone = ReturnType<typeof getStockTone>;

const itemsCss = `
[data-inventory-truth-list] {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.truth-list-hero,
.truth-list-empty,
.truth-item-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
}

.truth-list-hero {
  padding: 18px;
}

.truth-list-kicker {
  margin-bottom: 8px;
  color: #2563eb;
  font-size: 0.78rem;
  font-weight: 900;
}

.truth-list-hero h1 {
  margin: 0;
  color: #0f172a;
  font-size: 1.35rem;
  line-height: 1.2;
  font-weight: 900;
}

.truth-list-hero p {
  margin: 8px 0 0;
  color: #64748b;
  font-size: 0.92rem;
  line-height: 1.55;
}

.truth-search {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  border: 1px solid #dbe3ef;
  border-radius: 15px;
  background: #f8fafc;
  padding: 0 12px;
}

.truth-search input {
  border: 0;
  outline: 0;
  background: transparent;
  width: 100%;
  min-width: 0;
  font: inherit;
  color: #0f172a;
}

.truth-list-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.truth-stat-card {
  min-height: 78px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #ffffff;
}

.truth-stat-card strong {
  display: block;
  color: #0f172a;
  font-size: 1.25rem;
  line-height: 1;
}

.truth-stat-card span {
  display: block;
  margin-top: 7px;
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 800;
}

.truth-items-list {
  display: grid;
  gap: 12px;
}

.truth-item-card {
  width: 100%;
  border-color: #e5e7eb;
  padding: 14px;
  text-align: right;
  color: inherit;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  gap: 12px;
  cursor: pointer;
}

.truth-item-card:focus-visible,
.truth-add-button:focus-visible {
  outline: 3px solid rgba(37, 99, 235, 0.25);
  outline-offset: 2px;
}

.truth-item-status {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 900;
}

.truth-item-status--critical {
  background: #fee2e2;
  color: #dc2626;
}

.truth-item-status--low {
  background: #fef3c7;
  color: #b45309;
}

.truth-item-status--ok {
  background: #dcfce7;
  color: #166534;
}

.truth-item-name {
  display: block;
  margin-top: 10px;
  color: #0f172a;
  font-size: 1rem;
  line-height: 1.35;
  font-weight: 900;
}

.truth-item-stock {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.truth-item-stock span {
  border-radius: 14px;
  background: #f8fafc;
  padding: 9px;
  color: #475569;
  font-size: 0.76rem;
  line-height: 1.35;
}

.truth-item-stock strong {
  display: block;
  margin-top: 3px;
  color: #0f172a;
  font-size: 0.95rem;
}

.truth-item-meta {
  margin-top: 10px;
  color: #64748b;
  font-size: 0.8rem;
  line-height: 1.45;
}

.truth-item-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: #334155;
}

.truth-list-empty {
  padding: 28px 18px;
  text-align: center;
  color: #64748b;
}

.truth-list-empty strong {
  display: block;
  margin-bottom: 8px;
  color: #0f172a;
  font-size: 1rem;
}

.truth-add-button {
  width: 100%;
  min-height: 52px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(135deg, #2563eb, #0f766e);
  color: #ffffff;
  font: inherit;
  font-size: 0.95rem;
  font-weight: 900;
  cursor: pointer;
  box-shadow: 0 12px 24px rgba(37, 99, 235, 0.18);
}

@media (max-width: 380px) {
  .truth-list-stats,
  .truth-item-stock {
    grid-template-columns: 1fr;
  }
}
`;

export default function InventoryItemsListPage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const toneOrder: Record<StockTone, number> = { critical: 0, low: 1, ok: 2 };
      const ta = toneOrder[getStockTone(a)];
      const tb = toneOrder[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
  }, [items]);

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return sortedItems;

    return sortedItems.filter((item) => {
      return [item.name, item.barcode, item.sku, item.supplierName, item.category?.name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value));
    });
  }, [query, sortedItems]);

  const counts = useMemo(() => {
    return sortedItems.reduce(
      (acc, item) => {
        acc[getStockTone(item)] += 1;
        return acc;
      },
      { critical: 0, low: 0, ok: 0 } as Record<StockTone, number>
    );
  }, [sortedItems]);

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

      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת הפריטים");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadItems();
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <InventorySubPage
      title="כל הפריטים"
      backHref="/inventory"
      backLabel="טיפול עכשיו"
      bottomNav="products"
    >
      <style>{itemsCss}</style>

      <div data-inventory-truth-list>
        <section className="truth-list-hero">
          <div className="truth-list-kicker">מלאי · אמת</div>
          <h1>מה באמת יש במלאי?</h1>
          <p>הפריטים מסודרים לפי מצב קודם, כדי לראות מיד מה תקין ומה דורש תשומת לב.</p>

          <label className="truth-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="חיפוש מוצר, ספק או ברקוד"
            />
          </label>
        </section>

        <section className="truth-list-stats" aria-label="סיכום מצב מלאי">
          <StatCard label="קריטי" value={counts.critical} />
          <StatCard label="נמוך" value={counts.low} />
          <StatCard label="תקין" value={counts.ok} />
        </section>

        {error ? (
          <section className="truth-list-empty" role="alert">
            <strong>משהו השתבש</strong>
            <span>{error}</span>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="truth-add-button" onClick={() => void loadItems()}>
                נסה שוב
              </button>
            </div>
          </section>
        ) : loading ? (
          <section className="truth-list-empty">טוען פריטים...</section>
        ) : filteredItems.length === 0 ? (
          <section className="truth-list-empty">
            <strong>{items.length === 0 ? "עדיין אין פריטים במלאי" : "לא נמצאו פריטים"}</strong>
            <span>
              {items.length === 0
                ? "כשתוסיף פריטים הם יופיעו כאן לפי מצב המלאי שלהם."
                : "נסה חיפוש קצר יותר או חזור לרשימה המלאה."}
            </span>
          </section>
        ) : (
          <section className="truth-items-list" aria-label="רשימת פריטים">
            {filteredItems.map((item) => (
              <ItemCard key={item.id} item={item} onOpen={() => router.push(`/inventory/items/${item.id}`)} />
            ))}
          </section>
        )}

        <button type="button" className="truth-add-button" onClick={() => router.push("/inventory/items/create")}>
          הוסף מוצר
        </button>
      </div>
    </InventorySubPage>
  );
}

function ItemCard({ item, onOpen }: { item: InventoryItemDTO; onOpen: () => void }) {
  const tone = getStockTone(item);
  const stockCopy = getStockCopy(tone);
  const reorderValue = item.reorderPoint ?? "לא הוגדרה";

  return (
    <button type="button" className="truth-item-card" onClick={onOpen}>
      <span>
        <span className={`truth-item-status truth-item-status--${tone}`}>{stockCopy.label}</span>
        <span className="truth-item-name">{item.name}</span>

        <span className="truth-item-stock">
          <span>
            כמות
            <strong>{item.currentQuantity}</strong>
          </span>
          <span>
            מינימום
            <strong>{item.minimumQuantity}</strong>
          </span>
          <span>
            הזמנה
            <strong>{reorderValue}</strong>
          </span>
        </span>

        <span className="truth-item-meta">
          {[item.category?.name, item.supplierName, item.barcode ? `ברקוד ${item.barcode}` : null]
            .filter(Boolean)
            .join(" · ") || "אין פרטים משניים"}
        </span>
      </span>

      <span className="truth-item-chevron" aria-hidden>
        <ChevronLeftIcon />
      </span>
    </button>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="truth-stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function getStockCopy(tone: StockTone) {
  if (tone === "critical") {
    return { label: "מצב קריטי" };
  }

  if (tone === "low") {
    return { label: "דורש תשומת לב" };
  }

  return { label: "תקין" };
}

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function SearchIcon() {
  return (
    <Svg size={18}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function ChevronLeftIcon() {
  return (
    <Svg size={18}>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
