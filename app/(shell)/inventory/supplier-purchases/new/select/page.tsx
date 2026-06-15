"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { ItemThumb } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";

export default function NewSupplierPurchaseSelectPage() {
  const router = useRouter();
  const {
    summary,
    order,
    supplierName,
    setSupplierName,
    categoryId,
    setCategoryId,
    productSearch,
    setProductSearch,
    supplierOptions,
    filteredCategories,
    supplierHasItems,
    browsableItems,
    getCategoryName,
    quickAddItem,
  } = useOrderWizard();

  const canContinue = summary.totalItems > 0;

  return (
    <OrderWizardShell
      title="יצירת הזמנה חדשה"
      backHref="/inventory/supplier-purchases/new"
      showProgress={true}
      footer={null}
    >
      <article className="owz-step" aria-label="בחירת מוצרים להזמנה">
        <header className="owz-step__head">
          <span className="owz-step__eyebrow">שלב 2 מתוך 4</span>
          <h1 className="owz-step__title">בחרו מה להזמין</h1>
          <p className="owz-step__sub">
            {summary.totalItems > 0
              ? `${summary.totalItems} פריטים בעגלה. אפשר להוסיף עוד או להמשיך לעדכון כמויות.`
              : "בחרו ספק או קטגוריה, חפשו מוצר והוסיפו אותו להזמנה."}
          </p>
        </header>

        <section className="owz-step__content">
          <div className="owz-filters-bar" aria-label="סינון מוצרים">
            <select
              className="owz-filters-bar__input"
              value={supplierName}
              onChange={(e) => {
                setSupplierName(e.target.value);
                setCategoryId("");
                setProductSearch("");
              }}
              aria-label="ספק"
            >
              <option value="">כל הספקים</option>
              {supplierOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="owz-filters-bar__input"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setProductSearch("");
              }}
              aria-label="קטגוריה"
            >
              <option value="">כל הקטגוריות</option>
              {filteredCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="search"
              className="owz-filters-bar__input"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="חיפוש לפי שם מוצר..."
              aria-label="חיפוש מוצר"
            />
          </div>

          {browsableItems.length === 0 ? (
            <div className="owz-step__empty">
              <div className="owz-step__empty-title">לא נמצאו מוצרים</div>
              <p>
                {supplierName.trim() && !supplierHasItems
                  ? "אין מוצרים לספק שנבחר. נסו ספק אחר או בטלו את הסינון."
                  : "אין התאמה לחיפוש הנוכחי. נסו לחפש שם אחר או לשנות סינון."}
              </p>
            </div>
          ) : (
            <ul className="owz-products-list" role="list">
              {browsableItems.map((item) => {
                const inCart = Boolean(order[item.id]);
                return (
                  <li
                    key={item.id}
                    className={`owz-product-detail-row${
                      inCart ? " is-in-cart" : ""
                    }`}
                  >
                    <span className="owz-product-detail-row__thumb">
                      <ItemThumb
                        name={item.name}
                        imageUrl={item.imageUrl}
                        size={52}
                      />
                    </span>
                    <div className="owz-product-detail-row__info">
                      <span className="owz-product-detail-row__name">
                        {item.name}
                      </span>
                      <span className="owz-product-detail-row__meta">
                        {getCategoryName(item)} · במלאי {item.currentQuantity}
                      </span>
                    </div>
                    <span className="owz-product-detail-row__incart">
                      {inCart ? `${order[item.id]} בעגלה` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => quickAddItem(item)}
                      className="owz-product-detail-row__add"
                      aria-label={`הוסף ${item.name}`}
                    >
                      +
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="owz-step__actions">
          <Link
            href="/inventory/supplier-purchases/new"
            className="owz-step__back"
          >
            חזרה להמלצות
          </Link>
          <button
            type="button"
            disabled={!canContinue}
            onClick={() =>
              router.push("/inventory/supplier-purchases/new/cart")
            }
            className="owz-step__next"
          >
            המשך לעגלה ({summary.totalItems})
          </button>
        </footer>
      </article>
    </OrderWizardShell>
  );
}
