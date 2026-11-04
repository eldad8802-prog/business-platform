"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { I2, InvButton, InvField, InvNote, InvQty, InvRow, InvSearch, InvState, ProductThumb } from "@/components/inventory/v2/kit";
import { unitWord } from "@/lib/inventory/unit-words";

const PAGE = 30;

function readId(params: URLSearchParams, key: string): number | null {
  const v = Number(params.get(key));
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Order wizard step 1 — choose products (redesign, mockup "הזמנה חדשה"). */
export default function NewSupplierPurchaseSelectPage() {
  const router = useRouter();
  const {
    loading,
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
    quickAddItem,
    setOrder,
    suggestionCount,
    suggestedInCart,
    addSuggestions,
    removeSuggestions,
    applyPreselect,
  } = useOrderWizard();
  const [shown, setShown] = useState(PAGE);

  // ?item= / ?supplier= (from the overview, a product, the supplier card) — once, after load.
  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams(window.location.search);
    applyPreselect({ itemId: readId(params, "item"), supplierId: readId(params, "supplier") });
  }, [loading, applyPreselect]);

  const setQty = (id: number, qty: number) =>
    setOrder((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });

  const canContinue = summary.totalItems > 0;
  const list = browsableItems.slice(0, shown);

  return (
    <OrderWizardShell
      title="הזמנה חדשה"
      backFallback="/inventory/supplier-purchases"
      footer={
        <div className="i2-footer__row">
          <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
            {summary.totalItems === 1 ? "מוצר אחד בעגלה" : `${summary.totalItems.toLocaleString("he-IL")} מוצרים בעגלה`}
          </span>
          <InvButton disabled={!canContinue} onClick={() => router.push("/inventory/supplier-purchases/new/cart")}>
            המשך לעגלה
          </InvButton>
        </div>
      }
    >
      <InvField label="ספק" htmlFor="owz-supplier">
        <select
          id="owz-supplier"
          className="i2-select"
          value={supplierKey}
          onChange={(e) => {
            selectSupplier(e.target.value);
            setCategoryId("");
            setProductSearch("");
            setShown(PAGE);
          }}
        >
          <option value="">כל הספקים</option>
          {supplierChoices.map((choice) => {
            const key = choice.id != null ? `id:${choice.id}` : `name:${choice.name}`;
            return (
              <option key={key} value={key}>
                {choice.name}
              </option>
            );
          })}
        </select>
      </InvField>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(120px, 40%)", gap: 8, alignItems: "center" }}>
        <InvSearch
          value={productSearch}
          onChange={(v) => {
            setProductSearch(v);
            setShown(PAGE);
          }}
          placeholder="חיפוש מוצר"
        />
        <label style={{ margin: "4px 0 12px" }}>
          <span className="i2-sr">קטגוריה</span>
          <select
            className="i2-select"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setProductSearch("");
              setShown(PAGE);
            }}
          >
            <option value="">כל הקטגוריות</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {suggestionCount > 0 ? (
        <InvNote>
          <div style={{ fontWeight: 600 }}>הצעות למוצרים חסרים — לבחירתך</div>
          {suggestedInCart > 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span>נוספו {suggestedInCart === 1 ? "מוצר אחד" : `${suggestedInCart.toLocaleString("he-IL")} מוצרים`} לפי מלאי חסר</span>
              <button type="button" className="i2-underline" onClick={removeSuggestions}>
                הסרת ההצעות
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span>{suggestionCount === 1 ? "מוצר אחד" : `${suggestionCount.toLocaleString("he-IL")} מוצרים`} במלאי חסר</span>
              <button type="button" className="i2-underline" onClick={addSuggestions}>
                הוספת ההצעות
              </button>
            </div>
          )}
        </InvNote>
      ) : null}

      {browsableItems.length === 0 ? (
        <InvState
          title="לא נמצאו מוצרים"
          body={
            supplierName.trim() && !supplierHasItems
              ? "לספק הזה עוד אין מוצרים משויכים. בחרו ״כל הספקים״ כדי לראות את כל המוצרים."
              : productSearch.trim()
                ? `אין מוצר שתואם ל״${productSearch.trim()}״.`
                : "אין מוצרים בבחירה הזו."
          }
          action={
            productSearch.trim() || categoryId || supplierKey ? (
              <InvButton
                kind="secondary"
                onClick={() => {
                  setProductSearch("");
                  setCategoryId("");
                  selectSupplier("");
                }}
              >
                הצגת כל המוצרים
              </InvButton>
            ) : (
              <InvButton href="/inventory/items/create">הוספת מוצר</InvButton>
            )
          }
        />
      ) : (
        <>
          <ul className="i2-list">
            {list.map((item) => {
              const inCart = Number(order[item.id] || 0);
              return (
                <InvRow
                  key={item.id}
                  thumb={<ProductThumb src={item.imageUrl} name={item.name} />}
                  title={item.name}
                  sub={<span className="i2-clamp2">{item.supplierName?.trim() && !supplierName.trim() ? item.supplierName : unitWord(item.unitType, 2)}</span>}
                  trail={
                    inCart > 0 ? (
                      <InvQty size="sm" value={inCart} min={0} label={`כמות בעגלה · ${item.name}`} onChange={(v) => setQty(item.id, v)} />
                    ) : (
                      <button
                        type="button"
                        className="i2-qty__b"
                        style={{ background: "var(--i2-green)", color: "#fff" }}
                        onClick={() => quickAddItem(item)}
                        aria-label={`הוספה לעגלה · ${item.name}`}
                      >
                        {I2.plus(22)}
                      </button>
                    )
                  }
                />
              );
            })}
          </ul>
          {browsableItems.length > shown ? (
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <InvButton kind="secondary" onClick={() => setShown((n) => n + PAGE)}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
        </>
      )}
    </OrderWizardShell>
  );
}
