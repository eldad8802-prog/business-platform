"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  HubActionCard,
  InventorySubheader,
  PageIntro,
  SectionHeader,
  inventoryCardStyle,
  inventoryMainStyle,
  inventoryPageStyle,
  inventoryTheme,
} from "@/components/inventory/inventory-design";

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
        // Silent fail — suggestions are an enhancement, not a core flow.
      }
    }
    fetchReorderSuggestions();
  }, []);

  function prefillAndNavigate(suggestion: SupplierReorderSuggestion) {
    const order: Record<number, number> = {};
    for (const line of suggestion.lines) {
      order[line.matchedItemId] = line.medianQty;
    }
    const draft = {
      version: 1,
      savedAt: new Date().toISOString(),
      supplierName: suggestion.supplierName,
      order,
      categoryId: "",
      itemId: "",
      quantity: "1",
    };
    localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
    router.push("/inventory/supplier-purchases/new");
  }

  const timelySuggestions = reorderSuggestions.filter((s) => s.isTimely);

  return (
    <div style={inventoryPageStyle()}>
      <InventorySubheader title="הזמנות ספק" backHref="/inventory" />

      <main style={inventoryMainStyle(760)}>
        <PageIntro
          stage="מרכז הזמנות"
          title="ניהול הזמנות ספק"
          description="תכנון הזמנות, קליטת סחורה ועדכון מלאי — הכל במקום אחד."
          tone="accent"
        />

        {timelySuggestions.length > 0 ? (
          <section style={inventoryCardStyle()}>
            <SectionHeader title="מומלץ להזמין עכשיו" />
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {timelySuggestions.slice(0, 3).map((suggestion) => (
                <article
                  key={suggestion.supplierName}
                  style={{
                    border: "1px solid #bbf7d0",
                    borderRadius: 16,
                    background: "#ecfdf5",
                    padding: 14,
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 950, color: "#047857" }}>
                      {suggestion.supplierName}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: inventoryTheme.textMuted,
                        lineHeight: 1.5,
                      }}
                    >
                      בדרך כלל כל ~{suggestion.medianIntervalDays} ימים · עבר{" "}
                      {suggestion.daysSinceLast} ימים ·{" "}
                      {suggestion.recurringItemCount} פריטים שחוזרים
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => prefillAndNavigate(suggestion)}
                    style={{
                      minHeight: 40,
                      padding: "0 16px",
                      borderRadius: 12,
                      border: "none",
                      background: inventoryTheme.successBtn,
                      color: "#ffffff",
                      fontSize: 13,
                      fontWeight: 950,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    צור טיוטה דומה
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section style={inventoryCardStyle()}>
          <SectionHeader title="מה תרצו לעשות?" />
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <HubActionCard
              accent
              icon="📦"
              title="יצירת הזמנה חדשה"
              description="המערכת תציע מה להזמין לפי מצב המלאי"
              onClick={() => router.push("/inventory/supplier-purchases/new")}
            />
            <HubActionCard
              icon="⏳"
              title="הזמנות שממתינות לקליטה"
              description="אישור קבלת סחורה יעדכן את המלאי בפועל"
              onClick={() => router.push("/inventory/supplier-purchases/pending")}
            />
            <HubActionCard
              icon="📊"
              title="הזמנות אחרונות"
              description="צפייה בהזמנות שאושרו או בוטלו"
              onClick={() => router.push("/inventory/supplier-purchases/history")}
            />
            <HubActionCard
              icon="📄"
              title="ייבוא CSV"
              description="העלאת קובץ מהספק ליצירת טיוטות לבדיקה לפני קליטת מלאי"
              onClick={() => router.push("/inventory/supplier-purchases/import")}
            />
            <HubActionCard
              icon="🔌"
              title="חיבורי ספקים"
              description="תשתית לחיבור ספקים וקטלוגים — בשלבי הרחבה"
              onClick={() => router.push("/inventory/supplier-purchases/integrations")}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
