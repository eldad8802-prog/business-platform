"use client";

import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";

export default function SupplierPurchasesHubPage() {
  const router = useRouter();

  function goToNew() {
    router.push("/inventory/supplier-purchases/new");
  }

  function goToPending() {
    router.push("/inventory/supplier-purchases/pending");
  }

  function goToHistory() {
    router.push("/inventory/supplier-purchases/history");
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
            }}
          >
            תכנון הזמנות, קליטת סחורה ועדכון מלאי — הכל במקום אחד.
          </div>
        </section>

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
              textAlign: "right",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
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
              textAlign: "right",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
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
              textAlign: "right",
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
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
              }}
            >
              צפייה בהזמנות שאושרו או בוטלו
            </div>
          </button>
        </section>
      </main>
    </div>
  );
}