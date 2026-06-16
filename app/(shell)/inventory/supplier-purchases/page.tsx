"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";

const LOCAL_DRAFT_KEY = "inventory:supplierPurchases:newDraft:v1";

type SuggestionLine = {
  matchedItemId: number;
  name: string;
  medianQty: number;
};

type SupplierReorderSuggestion = {
  supplierName: string;
  lastApprovedAt: string;
  medianIntervalDays: number;
  daysSinceLast: number;
  isTimely: boolean;
  recurringItemCount: number;
  lines: SuggestionLine[];
};

const purchasingHubCss = `
[data-purchasing-hub] {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.purchasing-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  padding: 18px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
}

.purchasing-hero h1 {
  margin: 0;
  color: #0f172a;
  font-size: 1.35rem;
  line-height: 1.2;
  font-weight: 900;
}

.purchasing-hero p,
.purchasing-section-copy {
  margin: 8px 0 0;
  color: #64748b;
  font-size: 0.9rem;
  line-height: 1.55;
}

.purchasing-kicker {
  margin-bottom: 8px;
  color: #16a34a;
  font-size: 0.78rem;
  font-weight: 900;
}

.purchasing-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.purchasing-row {
  width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 17px;
  background: #ffffff;
  padding: 14px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 28px;
  gap: 12px;
  align-items: center;
  text-align: right;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.purchasing-row__icon {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: #ecfdf5;
  color: #16a34a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.purchasing-row__title {
  display: block;
  color: #0f172a;
  font-weight: 900;
  line-height: 1.3;
}

.purchasing-row__meta {
  display: block;
  margin-top: 4px;
  color: #64748b;
  font-size: 0.82rem;
  line-height: 1.45;
}

.purchasing-row__badge {
  display: inline-flex;
  width: fit-content;
  margin-top: 8px;
  border-radius: 999px;
  background: #dcfce7;
  color: #166534;
  padding: 4px 9px;
  font-size: 0.74rem;
  font-weight: 900;
}

.purchasing-row__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #334155;
}

.purchasing-primary {
  min-height: 52px;
  border: 0;
  border-radius: 16px;
  background: #2563eb;
  color: #ffffff;
  font: inherit;
  font-weight: 900;
  box-shadow: 0 12px 24px rgba(37, 99, 235, 0.18);
  cursor: pointer;
}
`;

export default function SupplierPurchasesHubPage() {
  const router = useRouter();
  const [reorderSuggestions, setReorderSuggestions] = useState<
    SupplierReorderSuggestion[]
  >([]);

  useEffect(() => {
    async function fetchReorderSuggestions() {
      try {
        const token =
          typeof window !== "undefined" ? localStorage.getItem("token") : null;
        const res = await fetch(
          "/api/inventory/supplier-purchases/reorder-suggestions",
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            cache: "no-store",
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.suggestions)) {
          setReorderSuggestions(data.suggestions);
        }
      } catch {
        // Suggestions are helpful, but the purchasing hub works without them.
      }
    }

    void fetchReorderSuggestions();
  }, []);

  function prefillAndNavigate(suggestion: SupplierReorderSuggestion) {
    const order: Record<number, number> = {};
    for (const line of suggestion.lines) {
      order[line.matchedItemId] = line.medianQty;
    }

    localStorage.setItem(
      LOCAL_DRAFT_KEY,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        supplierName: suggestion.supplierName,
        order,
        categoryId: "",
        itemId: "",
        quantity: "1",
      })
    );

    router.push("/inventory/supplier-purchases/new");
  }

  const timelySuggestions = reorderSuggestions.filter(
    (suggestion) => suggestion.isTimely
  );

  return (
    <InventorySubPage
      title="רכש"
      backHref="/inventory"
      backLabel="טיפול עכשיו"
      bottomNav="orders"
    >
      <style>{purchasingHubCss}</style>

      <div data-purchasing-hub>
        <section className="purchasing-card purchasing-hero">
          <div className="purchasing-kicker">רכש · מה צריך להזמין</div>
          <h1>מה כדאי להזמין עכשיו?</h1>
          <p>
            מרכז הרכש מציג המלצות, הזמנות שממתינות לקליטה והפעולה הבאה מול
            ספקים.
          </p>
        </section>

        <section className="purchasing-card">
          <div className="purchasing-kicker">מומלץ להזמין עכשיו</div>
          <p className="purchasing-section-copy">
            {timelySuggestions.length > 0
              ? "יש ספקים שכדאי לבדוק עכשיו לפי דפוסי הזמנה ומצב המלאי."
              : "אין כרגע המלצה דחופה. אפשר ליצור הזמנה ידנית בכל רגע."}
          </p>

          {timelySuggestions.length > 0 ? (
            <div className="purchasing-list">
              {timelySuggestions.slice(0, 3).map((suggestion) => (
                <button
                  key={suggestion.supplierName}
                  type="button"
                  className="purchasing-row"
                  onClick={() => prefillAndNavigate(suggestion)}
                >
                  <span className="purchasing-row__icon">
                    <CartIcon />
                  </span>
                  <span>
                    <span className="purchasing-row__title">
                      {suggestion.supplierName}
                    </span>
                    <span className="purchasing-row__meta">
                      עברו {suggestion.daysSinceLast} ימים ·{" "}
                      {suggestion.recurringItemCount} פריטים חוזרים
                    </span>
                    <span className="purchasing-row__badge">
                      צור טיוטה דומה
                    </span>
                  </span>
                  <span className="purchasing-row__chevron" aria-hidden>
                    <ChevronLeftIcon />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="purchasing-card">
          <div className="purchasing-kicker">מה הפעולה הבאה?</div>
          <div className="purchasing-list">
            <ActionRow
              icon={<PlusIcon />}
              title="צור הזמנה חדשה"
              meta="בחירת מוצרים, בדיקת כמויות ואישור לפני שליחה לספק"
              onClick={() => router.push("/inventory/supplier-purchases/new")}
            />
            <ActionRow
              icon={<TruckIcon />}
              title="הזמנות שמחכות לקליטה"
              meta="קליטת סחורה מעדכנת מלאי בפועל"
              onClick={() => router.push("/inventory/supplier-purchases/pending")}
            />
            <ActionRow
              icon={<HistoryIcon />}
              title="היסטוריית הזמנות"
              meta="צפייה במה שנשלח, נקלט או בוטל"
              onClick={() => router.push("/inventory/supplier-purchases/history")}
            />
          </div>
        </section>

        <button
          type="button"
          className="purchasing-primary"
          onClick={() => router.push("/inventory/supplier-purchases/new")}
        >
          יצירת הזמנה חדשה
        </button>
      </div>
    </InventorySubPage>
  );
}

function ActionRow({
  icon,
  title,
  meta,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="purchasing-row" onClick={onClick}>
      <span className="purchasing-row__icon">{icon}</span>
      <span>
        <span className="purchasing-row__title">{title}</span>
        <span className="purchasing-row__meta">{meta}</span>
      </span>
      <span className="purchasing-row__chevron" aria-hidden>
        <ChevronLeftIcon />
      </span>
    </button>
  );
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <Svg size={18}>
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CartIcon() {
  return (
    <Svg>
      <path
        d="M4 5h2l2.3 10.5a2 2 0 002 1.5h6.7a2 2 0 002-1.5L21 9H7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="20" r="1.5" fill="currentColor" />
      <circle cx="18" cy="20" r="1.5" fill="currentColor" />
    </Svg>
  );
}

function PlusIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 8v8M8 12h8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

function TruckIcon() {
  return (
    <Svg>
      <path d="M3 7h11v9H3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path
        d="M14 10h4l3 3v3h-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="18" r="1.8" fill="currentColor" />
      <circle cx="18" cy="18" r="1.8" fill="currentColor" />
    </Svg>
  );
}

function HistoryIcon() {
  return (
    <Svg>
      <path
        d="M4 12a8 8 0 118 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M4 12H2m2 0l3-3m-3 3l3 3M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
