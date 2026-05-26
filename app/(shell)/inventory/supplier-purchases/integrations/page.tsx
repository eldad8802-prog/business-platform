"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/page-header";

export default function SupplierPurchasesIntegrationsPage() {
  const [showComingSoon, setShowComingSoon] = useState(false);

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader
        title="חיבורי ספקים"
        backHref="/inventory/supplier-purchases"
      />

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
            חיבורי ספקים
          </div>

          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              lineHeight: 1.65,
              color: "rgba(255,255,255,0.85)",
              maxWidth: 520,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            חבר ספקים כדי למשוך קטלוגים והזמנות ישירות למערכת
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 22,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 950,
              color: "#111827",
              marginBottom: 8,
            }}
          >
            תשתית חיבורים (בבנייה)
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "#6b7280",
              lineHeight: 1.65,
              maxWidth: 520,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            בשלב הבא תוכלו לבקש מהספק מפתח API, להזין אותו כאן באופן מאובטח,
            והמערכת תוכל למשוך קטלוגים והזמנות מהספק — הכול מתוך המערכת שלכם,
            בלי לעבוד בתוך אתר הספק.
          </p>
        </section>

        <section
          style={{
            border: "1px dashed #d1d5db",
            borderRadius: 22,
            background: "#fafafa",
            padding: 28,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔌</div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 950,
              color: "#111827",
              marginBottom: 8,
            }}
          >
            עדיין אין חיבורים שמורים
          </div>
          <div
            style={{
              fontSize: 14,
              color: "#6b7280",
              lineHeight: 1.6,
              maxWidth: 440,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            כשתגדירו חיבורי ספק, הם יופיעו כאן. בשלב זה השמירה והחיבור האמיתיים
            עדיין לא זמינים.
          </div>
        </section>

        <button
          type="button"
          onClick={() => setShowComingSoon(true)}
          style={{
            minHeight: 54,
            borderRadius: 18,
            border: "none",
            background: "#111827",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 950,
            cursor: "pointer",
            boxShadow: "0 10px 22px rgba(17, 24, 39, 0.12)",
          }}
        >
          חיבור ספק חדש
        </button>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 18,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 950,
              color: "#111827",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            איך זה יעבוד בהמשך
          </div>
          <ol
            style={{
              margin: 0,
              paddingRight: 20,
              paddingLeft: 16,
              fontSize: 13,
              color: "#4b5563",
              lineHeight: 1.75,
              textAlign: "right",
            }}
          >
            <li>חיבור ספק עם מפתח API</li>
            <li>משיכת קטלוג הספק (קטגוריות ומוצרים)</li>
            <li>בניית הזמנה אצלנו במערכת</li>
            <li>שליחה לספק</li>
            <li>
              קליטת סחורה למלאי דרך בדיקת קבלה — רק אחרי אישור, כמו היום
            </li>
          </ol>
        </section>
      </main>

      {showComingSoon && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="integrations-dialog-title"
        >
          <section
            style={{
              width: "100%",
              maxWidth: 440,
              borderRadius: 22,
              background: "#ffffff",
              boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              textAlign: "center",
            }}
          >
            <div
              id="integrations-dialog-title"
              style={{
                fontSize: 17,
                fontWeight: 950,
                color: "#111827",
              }}
            >
              בשלב הבא
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: "#6b7280",
                lineHeight: 1.65,
              }}
            >
              יהיה אפשר להזין מפתח API מול הספק, לשמור חיבור מאובטח במערכת,
              ולבדוק שהחיבור תקין — לפני משיכת קטלוגים והזמנות אמיתית.
            </p>
            <button
              type="button"
              onClick={() => setShowComingSoon(false)}
              style={{
                minHeight: 46,
                borderRadius: 14,
                border: "none",
                background: "#111827",
                color: "#ffffff",
                fontWeight: 950,
                cursor: "pointer",
              }}
            >
              הבנתי
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
