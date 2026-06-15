"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { ItemThumb } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";

export default function NewSupplierPurchaseCartPage() {
  const router = useRouter();
  const {
    summary,
    selectedItems,
    order,
    incrementItem,
    decrementItem,
    removeItem,
    clearOrder,
    isSuggested,
    unitCosts,
    setUnitCost,
  } = useOrderWizard();

  const hasItems = selectedItems.length > 0;

  return (
    <OrderWizardShell
      title="יצירת הזמנה חדשה"
      backHref="/inventory/supplier-purchases/new/select"
      showProgress={true}
      footer={null}
    >
      <article className="owz-step" aria-label="עדכון עגלת הזמנה">
        <header className="owz-step__head">
          <span className="owz-step__eyebrow">שלב 3 מתוך 4</span>
          <h1 className="owz-step__title">בדיקת כמויות</h1>
          <p className="owz-step__sub">
            {hasItems
              ? `${summary.totalItems} מוצרים · ${summary.totalUnits} יחידות. עדכנו כמויות ועלות ליחידה אם ידועה.`
              : "העגלה ריקה כרגע. חזרו לבחירת מוצרים כדי להתחיל."}
          </p>
        </header>

        <section className="owz-step__content">
          {!hasItems ? (
            <div className="owz-step__empty">
              <div className="owz-step__empty-title">אין פריטים בעגלה</div>
              <Link
                href="/inventory/supplier-purchases/new/select"
                className="owz-step__empty-cta"
              >
                בחירת מוצרים
              </Link>
            </div>
          ) : (
            <>
              <ul className="owz-cart-detail-list" role="list">
                {selectedItems.map((item) => (
                  <li
                    key={item.id}
                    className={`owz-cart-detail-row${
                      isSuggested(item.id) ? " is-suggested" : ""
                    }`}
                  >
                    <span className="owz-cart-detail-row__thumb">
                      <ItemThumb
                        name={item.name}
                        imageUrl={item.imageUrl}
                        size={52}
                      />
                    </span>
                    <div className="owz-cart-detail-row__info">
                      <span className="owz-cart-detail-row__name">
                        {item.name}
                      </span>
                      <span className="owz-cart-detail-row__meta">
                        {isSuggested(item.id) ? "המלצת מערכת" : item.unitType}
                      </span>
                    </div>
                    <span
                      className="owz-cart-detail-row__qty"
                      role="group"
                      aria-label={`כמות ${item.name}`}
                    >
                      <button
                        type="button"
                        onClick={() => decrementItem(item.id)}
                        className="owz-cart-detail-row__qty-btn"
                        aria-label="הפחת כמות"
                      >
                        -
                      </button>
                      <span className="owz-cart-detail-row__qty-val">
                        {order[item.id]}
                      </span>
                      <button
                        type="button"
                        onClick={() => incrementItem(item.id)}
                        className="owz-cart-detail-row__qty-btn"
                        aria-label="הוסף כמות"
                      >
                        +
                      </button>
                    </span>
                    <label className="owz-cart-detail-row__cost">
                      <span className="owz-cart-detail-row__cost-label">
                        עלות ליחידה
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        className="owz-cart-detail-row__cost-input"
                        value={unitCosts[item.id] ?? ""}
                        onChange={(e) => setUnitCost(item.id, e.target.value)}
                        placeholder="לא חובה"
                        aria-label={`עלות ליחידה עבור ${item.name}`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="owz-cart-detail-row__remove"
                      aria-label={`הסר ${item.name}`}
                    >
                      הסרה
                    </button>
                  </li>
                ))}
              </ul>

              <div className="owz-cart-summary">
                <span className="owz-cart-summary__label">סיכום הזמנה</span>
                <span className="owz-cart-summary__values">
                  <strong>{summary.totalItems}</strong> מוצרים ·{" "}
                  <strong>{summary.totalUnits}</strong> יחידות
                </span>
                <button
                  type="button"
                  onClick={clearOrder}
                  className="owz-cart-summary__clear"
                >
                  נקה עגלה
                </button>
              </div>
            </>
          )}
        </section>

        <footer className="owz-step__actions">
          <Link
            href="/inventory/supplier-purchases/new/select"
            className="owz-step__back"
          >
            הוספת מוצרים
          </Link>
          <button
            type="button"
            disabled={!hasItems}
            onClick={() =>
              router.push("/inventory/supplier-purchases/new/confirm")
            }
            className="owz-step__next"
          >
            המשך לאישור
          </button>
        </footer>
      </article>
    </OrderWizardShell>
  );
}
