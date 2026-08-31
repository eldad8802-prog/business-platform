"use client";

import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import {
  InventorySearch,
  BottomActionBar,
  InventoryStatePanel,
} from "@/components/inventory/inventory-design";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

export default function NewSupplierPurchaseSelectPage() {
  const router = useRouter();
  const {
    summary,
    order,
    supplierKey,
    selectSupplier,
    supplierName,
    categoryId,
    setCategoryId,
    productSearch,
    setProductSearch,
    supplierChoices,
    filteredCategories,
    supplierHasItems,
    browsableItems,
    getCategoryName,
    quickAddItem,
  } = useOrderWizard();

  const canContinue = summary.totalItems > 0;

  return (
    <OrderWizardShell
      title="הזמנה חדשה"
      backHref="/inventory/supplier-purchases"
      showProgress={true}
      footer={
        <BottomActionBar
          label={`${summary.totalItems} מוצרים בעגלה`}
          value={<>{summary.totalUnits} יחידות</>}
          cta={`המשך לעגלה (${summary.totalItems})`}
          ctaDisabled={!canContinue}
          onCta={() => router.push("/inventory/supplier-purchases/new/cart")}
        />
      }
    >
      <InventorySearch value={productSearch} onChange={setProductSearch} placeholder="חיפוש לפי שם מוצר…" />

      <div className="inv-fwrap" style={{ paddingTop: 12 }}>
        <div className="inv-two">
          <div className="inv-field" style={{ marginTop: 0 }}>
            <select
              className="inv-input"
              value={supplierKey}
              onChange={(e) => {
                selectSupplier(e.target.value);
                setCategoryId("");
                setProductSearch("");
              }}
              aria-label="ספק"
            >
              <option value="">כל הספקים</option>
              {supplierChoices.map((choice) => {
                const key =
                  choice.id != null ? `id:${choice.id}` : `name:${choice.name}`;
                return (
                  <option key={key} value={key}>
                    {choice.name}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="inv-field" style={{ marginTop: 0 }}>
            <select
              className="inv-input"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setProductSearch("");
              }}
              aria-label="קטגוריה"
            >
              <option value="">כל הקטגוריות</option>
              {filteredCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {browsableItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="לא נמצאו מוצרים">
            {supplierName.trim() && !supplierHasItems
              ? "אין מוצרים לספק שנבחר. נסו ספק אחר או בטלו את הסינון."
              : "אין התאמה לחיפוש. נסו שם אחר או שנו סינון."}
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {browsableItems.map((item) => {
            const inCart = order[item.id] ?? 0;
            return (
              <div key={item.id} className="inv-row" style={{ cursor: "default" }}>
                <span className="inv-row__thumb" style={{ background: "var(--inv-surface)" }} aria-hidden>
                  <span style={{ fontSize: 26 }}>{getProductEmoji(item.name, getCategoryName(item))}</span>
                </span>
                <span className="inv-row__mid">
                  <span className="inv-row__nm">{item.name}</span>
                  <span className="inv-row__meta">
                    {getCategoryName(item)} · במלאי <bdi>{item.currentQuantity}</bdi>
                  </span>
                </span>
                <span className="inv-row__trail" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {inCart > 0 ? <span className="inv-row__meta">{inCart} בעגלה</span> : null}
                  <button
                    type="button"
                    className="inv-iconbtn inv-iconbtn--acc"
                    style={{ width: 38, height: 38 }}
                    onClick={() => quickAddItem(item)}
                    aria-label={`הוסף ${item.name}`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 5v14M5 12h14" stroke="var(--inv-on-accent)" strokeWidth="2.4" strokeLinecap="round" /></svg>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </OrderWizardShell>
  );
}
