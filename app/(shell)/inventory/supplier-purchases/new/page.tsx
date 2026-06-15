"use client";

import { useRouter } from "next/navigation";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";

export default function NewSupplierPurchasePage() {
  const router = useRouter();
  const {
    summary,
    recommendationsBanner,
    dismissRecommendationsBanner,
    applyRecommendations,
    persistDraft,
  } = useOrderWizard();

  return (
    <OrderWizardShell
      title="יצירת הזמנה חדשה"
      backHref="/inventory/supplier-purchases"
      showProgress
    >
      <article className="owz-step" aria-label="פתיחת הזמנה חדשה">
        <header className="owz-step__head">
          <span className="owz-step__eyebrow">שלב 1 מתוך 4</span>
          <h1 className="owz-step__title">מה צריך להזמין?</h1>
          <p className="owz-step__sub">
            התחילו מהמלצות המערכת או בחרו מוצרים בעצמכם. המלאי יתעדכן רק אחרי
            קליטה בפועל.
          </p>
        </header>

        <section className="owz-step__content">
          {recommendationsBanner ? (
            <div
              className="owz-state-card"
              style={{ borderColor: "#bbf7d0", background: "#f0fdf4", color: "#166534" }}
            >
              <strong>המלצות נטענו להזמנה</strong>
              <div style={{ marginTop: 6 }}>{recommendationsBanner}</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginTop: 12,
                }}
              >
                <button
                  type="button"
                  className="owz-step__next"
                  onClick={applyRecommendations}
                >
                  השתמש בהמלצות
                </button>
                <button
                  type="button"
                  className="owz-step__back"
                  onClick={dismissRecommendationsBanner}
                >
                  המשך בלי
                </button>
              </div>
            </div>
          ) : (
            <div className="owz-state-card">
              <strong>
                {summary.totalItems > 0
                  ? "יש פריטים בהזמנה"
                  : "אין עדיין פריטים בהזמנה"}
              </strong>
              <div style={{ marginTop: 6, color: "#64748b" }}>
                {summary.totalItems > 0
                  ? `${summary.totalItems} מוצרים · ${summary.totalUnits} יחידות מוכנים לבדיקה.`
                  : "בשלב הבא בוחרים מוצרים וכמויות."}
              </div>
            </div>
          )}
        </section>

        <footer className="owz-step__actions">
          <button
            type="button"
            className="owz-step__next"
            onClick={() => router.push("/inventory/supplier-purchases/new/select")}
          >
            בחירת מוצרים
          </button>
          <button type="button" className="owz-step__back" onClick={persistDraft}>
            שמור להמשך
          </button>
        </footer>
      </article>
    </OrderWizardShell>
  );
}
