"use client";

import Link from "next/link";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { ItemThumb } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";

function formatHebDate(d: Date) {
  return d.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function NewSupplierPurchaseConfirmPage() {
  const {
    summary,
    selectedItems,
    order,
    unitCosts,
    supplierName,
    setSupplierName,
    supplierOptions,
    createOrder,
    actionLoading,
    persistDraft,
  } = useOrderWizard();

  const canSubmit = summary.totalItems > 0 && !actionLoading;
  const today = formatHebDate(new Date());

  return (
    <OrderWizardShell
      title="אישור הזמנה"
      backHref="/inventory/supplier-purchases/new/cart"
      showProgress={true}
      footer={null}
    >
      <article className="owz-order-doc" aria-label="אישור הזמנה חדשה">
        <header className="owz-order-doc__header">
          <span className="owz-step__eyebrow">שלב 4 מתוך 4</span>
          <h1 className="owz-order-doc__title">מה יישלח לספק?</h1>
          <p className="owz-order-doc__meta">
            <span className="owz-order-doc__meta-item">
              <strong>{summary.totalItems}</strong> מוצרים
            </span>
            <span className="owz-order-doc__meta-item">
              <strong>{summary.totalUnits}</strong> יחידות
            </span>
            <span className="owz-order-doc__meta-item">
              תאריך:{" "}
              <span className="owz-order-doc__date" suppressHydrationWarning>
                {today || "היום"}
              </span>
            </span>
          </p>
          <label className="owz-order-doc__supplier-line">
            <span>ספק</span>
            <select
              className="owz-order-doc__supplier"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              aria-label="בחירת ספק"
            >
              <option value="">ללא ספק</option>
              {supplierOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </header>

        <section className="owz-order-doc__items" aria-label="פריטי ההזמנה">
          {selectedItems.length === 0 ? (
            <div className="owz-order-doc__empty">
              <div className="owz-step__empty-title">אין פריטים בהזמנה</div>
              <Link href="/inventory/supplier-purchases/new/select">
                חזרה לבחירת מוצרים
              </Link>
            </div>
          ) : (
            <ul className="owz-order-doc__list" role="list">
              {selectedItems.map((item) => (
                <li key={item.id} className="owz-order-doc__row">
                  <span className="owz-order-doc__row-thumb">
                    <ItemThumb
                      name={item.name}
                      imageUrl={item.imageUrl}
                      size={42}
                    />
                  </span>
                  <span className="owz-order-doc__row-name">{item.name}</span>
                  <span className="owz-order-doc__row-qty">
                    {order[item.id]} יחידות
                  </span>
                  <span className="owz-order-doc__row-unit">
                    {item.unitType}
                  </span>
                  <span className="owz-order-doc__row-cost">
                    {unitCosts[item.id]?.trim()
                      ? `${unitCosts[item.id].trim()} ₪`
                      : "עלות לא צוינה"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="owz-order-doc__actions">
          <button
            type="button"
            onClick={() => void createOrder()}
            disabled={!canSubmit}
            className="owz-order-doc__submit"
          >
            {actionLoading ? "יוצר הזמנה..." : "צור הזמנה"}
          </button>
          <button
            type="button"
            onClick={persistDraft}
            className="owz-order-doc__secondary"
          >
            שמור להמשך
          </button>
        </footer>

        <p className="owz-order-doc__footnote">
          המלאי יתעדכן רק לאחר קליטת הסחורה בפועל. יצירת ההזמנה לא משנה מלאי.
        </p>
      </article>
    </OrderWizardShell>
  );
}
