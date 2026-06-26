"use client";

import { useEffect } from "react";
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

  // The forward CTA navigates via a <button> (not <Link>), so the next step's
  // RSC payload isn't prefetched and a slow first click can read as "needs a
  // second tap". Warm it on mount so the transition is instant. (audit P1 #6)
  useEffect(() => {
    router.prefetch("/inventory/supplier-purchases/new/cart");
  }, [router]);

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
                <option key={s} value={s}>{s}</option>
              ))}
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
                <span className="inv-row__thumb" style={{ background: "var(--inv-surface, #f5f7f9)" }} aria-hidden>
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
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
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
