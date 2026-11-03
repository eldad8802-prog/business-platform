"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { I2, InvButton, InvConfirm, InvQty, InvState, ProductThumb, formatMoney } from "@/components/inventory/v2/kit";
import { unitWord } from "@/lib/inventory/unit-words";

/** Cost the line has, if any (the same parse the cart always used; validation stays at submit). */
function lineCost(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Order wizard step 2 — the cart (redesign, mockup "עגלת ההזמנה"). */
export default function NewSupplierPurchaseCartPage() {
  const router = useRouter();
  const { summary, selectedItems, order, setOrder, removeItem, clearOrder, unitCosts, setUnitCost } = useOrderWizard();
  const [confirmClear, setConfirmClear] = useState(false);

  const hasItems = selectedItems.length > 0;
  let known = 0;
  let missing = 0;
  for (const item of selectedItems) {
    const c = lineCost(unitCosts[item.id]);
    if (c == null) missing += 1;
    else known += (order[item.id] ?? 0) * c;
  }

  const setQty = (id: number, qty: number) =>
    setOrder((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });

  return (
    <OrderWizardShell
      title="עגלת ההזמנה"
      backFallback="/inventory/supplier-purchases/new"
      footer={
        hasItems ? (
          <>
            <div className="i2-footer__row">
              <InvButton onClick={() => router.push("/inventory/supplier-purchases/new/confirm")}>המשך לאישור</InvButton>
            </div>
            <div style={{ textAlign: "center" }}>
              <button type="button" className="i2-underline" onClick={() => setConfirmClear(true)}>
                ניקוי עגלה
              </button>
            </div>
          </>
        ) : undefined
      }
    >
      {!hasItems ? (
        <InvState
          title="העגלה ריקה"
          body="בחרו מוצרים להזמנה, והם יופיעו כאן."
          action={<InvButton href="/inventory/supplier-purchases/new">לבחירת מוצרים</InvButton>}
        />
      ) : (
        <>
          <div style={{ display: "grid", gap: 10 }}>
            {selectedItems.map((item) => {
              const qty = order[item.id] ?? 0;
              const cost = lineCost(unitCosts[item.id]);
              const unit = unitWord(item.unitType, 1);
              const inputId = `owz-cost-${item.id}`;
              return (
                <div key={item.id} className="i2-card">
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <ProductThumb src={item.imageUrl} name={item.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="i2-row__title">
                        <span>{item.name}</span>
                      </div>
                    </div>
                    <button type="button" className="i2-iconbtn" onClick={() => removeItem(item.id)} aria-label={`הסרה מהעגלה · ${item.name}`}>
                      {I2.close(20)}
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                    <div style={{ textAlign: "center" }}>
                      <InvQty size="sm" value={qty} min={0} label={`כמות · ${item.name}`} onChange={(v) => setQty(item.id, v)} />
                      <div className="i2-muted" style={{ fontSize: 13, marginTop: 2 }}>{unitWord(item.unitType, qty)}</div>
                    </div>
                    <div style={{ flex: "1 1 140px", maxWidth: 220 }}>
                      <label htmlFor={inputId} className="i2-field__lab" style={{ display: "block", fontSize: 14 }}>
                        עלות ל{unit} <span className="i2-field__opt">(אופציונלי)</span>
                      </label>
                      <div className="i2-affix">
                        <input
                          id={inputId}
                          className="i2-input i2-num"
                          inputMode="decimal"
                          value={unitCosts[item.id] ?? ""}
                          onChange={(e) => setUnitCost(item.id, e.target.value)}
                        />
                        <span aria-hidden>₪</span>
                      </div>
                    </div>
                  </div>
                  <div className="i2-muted" style={{ marginTop: 8, fontSize: 14.5 }}>
                    {cost != null ? <>סה״כ: <bdi className="i2-num">{formatMoney(qty * cost)}</bdi></> : "ללא עלות"}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="i2-box" style={{ marginTop: 14 }}>
            <div>
              {summary.totalItems === 1 ? "מוצר אחד" : `${summary.totalItems.toLocaleString("he-IL")} מוצרים`} · עלות ידועה{" "}
              <bdi className="i2-num" style={{ fontWeight: 600 }}>{formatMoney(known)}</bdi>
            </div>
            {missing > 0 ? (
              <div className="i2-muted" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 14 }}>
                {I2.info(18)}
                <span>חלק מהעלויות לא הוזנו — הסכום כולל רק מוצרים עם עלות.</span>
              </div>
            ) : null}
          </div>
        </>
      )}

      {confirmClear ? (
        <InvConfirm
          title="לנקות את העגלה?"
          body="כל המוצרים יוסרו מהעגלה."
          confirmLabel="ניקוי עגלה"
          danger
          onConfirm={() => {
            clearOrder();
            setConfirmClear(false);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </OrderWizardShell>
  );
}
