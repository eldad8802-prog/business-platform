"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";

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

  function goToNew() {
    router.push("/inventory/supplier-purchases/new");
  }

  function goToPending() {
    router.push("/inventory/supplier-purchases/pending");
  }

  function goToHistory() {
    router.push("/inventory/supplier-purchases/history");
  }

  function goToImport() {
    router.push("/inventory/supplier-purchases/import");
  }

  function goToIntegrations() {
    router.push("/inventory/supplier-purchases/integrations");
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="הזמנות ספק" />

      <main
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Hero */}
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 28,
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 52%, #0f766e 100%)",
            padding: 22,
            boxShadow: "0 16px 40px rgba(15, 23, 42, 0.18)",
            color: "#ffffff",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 24,
              fontWeight: 950,
              lineHeight: 1.3,
            }}
          >
            ניהול הזמנות ספק
          </div>

          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              lineHeight: 1.6,
              color: "rgba(255,255,255,0.8)",
              maxWidth: 520,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            תכנון הזמנות, קליטת סחורה ועדכון מלאי — הכל במקום אחד.
          </div>
        </section>

        {/* Reorder suggestions — shown only when isTimely === true */}
        {reorderSuggestions.filter((s) => s.isTimely).length > 0 && (
          <section
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 900,
                color: "#374151",
                paddingRight: 4,
              }}
            >
              מומלץ להזמין עכשיו
            </div>

            {reorderSuggestions
              .filter((s) => s.isTimely)
              .slice(0, 3)
              .map((suggestion) => (
                <article
                  key={suggestion.supplierName}
                  style={{
                    border: "1px solid #d1fae5",
                    borderRadius: 22,
                    background: "#f0fdf4",
                    padding: 16,
                    boxShadow: "0 4px 12px rgba(16, 185, 129, 0.08)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 950,
                          color: "#065f46",
                        }}
                      >
                        {suggestion.supplierName}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#047857",
                          lineHeight: 1.5,
                        }}
                      >
                        בדרך כלל כל ~{suggestion.medianIntervalDays} ימים ·{" "}
                        עבר {suggestion.daysSinceLast} ימים ·{" "}
                        {suggestion.recurringItemCount} פריטים שחוזרים
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => prefillAndNavigate(suggestion)}
                      style={{
                        minHeight: 40,
                        padding: "0 16px",
                        borderRadius: 14,
                        border: "none",
                        background: "#059669",
                        color: "#ffffff",
                        fontSize: 13,
                        fontWeight: 950,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      צור טיוטה דומה
                    </button>
                  </div>
                </article>
              ))}
          </section>
        )}

        {/* Actions */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* New Order */}
          <button
            onClick={goToNew}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 22,
              background: "#ffffff",
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
              📦 יצירת הזמנה חדשה
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5,
                maxWidth: 520,
              }}
            >
              המערכת תציע מה להזמין לפי מצב המלאי
            </div>
          </button>

          {/* Pending */}
          <button
            onClick={goToPending}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 22,
              background: "#ffffff",
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
              ⏳ הזמנות שממתינות לקליטה
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5,
                maxWidth: 520,
              }}
            >
              אישור קבלת סחורה יעדכן את המלאי בפועל
            </div>
          </button>

          {/* History */}
          <button
            onClick={goToHistory}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 22,
              background: "#ffffff",
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
              📊 הזמנות אחרונות
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5,
                maxWidth: 520,
              }}
            >
              צפייה בהזמנות שאושרו או בוטלו
            </div>
          </button>

          {/* CSV Import */}
          <button
            onClick={goToImport}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 22,
              background: "#ffffff",
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
              📄 ייבוא CSV
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5,
                maxWidth: 520,
              }}
            >
              העלאת קובץ מהספק ליצירת טיוטות לבדיקה לפני קליטת מלאי
            </div>
          </button>

          {/* Supplier integrations */}
          <button
            onClick={goToIntegrations}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 22,
              background: "#ffffff",
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
              🔌 חיבורי ספקים
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5,
                maxWidth: 520,
              }}
            >
              תשתית לחיבור ספקים וקטלוגים — בשלבי הרחבה
            </div>
          </button>
        </section>
      </main>
    </div>
  );
}