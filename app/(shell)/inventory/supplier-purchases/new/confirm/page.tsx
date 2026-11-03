"use client";

import { useState } from "react";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import { InvButton, InvConfirm, InvField, InvNote, InvState } from "@/components/inventory/v2/kit";
import { qtyWithUnit } from "@/lib/inventory/unit-words";

/**
 * Order wizard step 3 — confirm (redesign, mockup "אישור הזמנה").
 * The supplier stays optional (an order may have no supplier, as today).
 * "צור הזמנה" runs the same createOrder; it creates a draft awaiting receipt and
 * neither changes stock nor messages the supplier.
 */
export default function NewSupplierPurchaseConfirmPage() {
  const { selectedItems, order, supplierKey, selectSupplier, supplierChoices, createOrder, actionLoading, persistDraft, summary } =
    useOrderWizard();
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);

  const canSubmit = summary.totalItems > 0 && !actionLoading;

  return (
    <OrderWizardShell
      title="אישור הזמנה"
      backFallback="/inventory/supplier-purchases/new/cart"
      footer={
        selectedItems.length > 0 ? (
          <>
            {saved ? <InvNote tone="ok">הטיוטה נשמרה במכשיר הזה</InvNote> : null}
            <div className="i2-footer__row">
              <InvButton disabled={!canSubmit} onClick={() => setConfirming(true)}>
                {actionLoading ? "יוצרים…" : "צור הזמנה"}
              </InvButton>
              <InvButton
                kind="secondary"
                onClick={() => {
                  persistDraft();
                  setSaved(true);
                }}
              >
                שמירת טיוטה במכשיר
              </InvButton>
            </div>
          </>
        ) : undefined
      }
    >
      {selectedItems.length === 0 ? (
        <InvState
          title="אין מוצרים בהזמנה"
          body="חזרו לבחירת מוצרים כדי ליצור הזמנה."
          action={<InvButton href="/inventory/supplier-purchases/new">לבחירת מוצרים</InvButton>}
        />
      ) : (
        <>
          <InvField label="ספק" optional htmlFor="owz-confirm-supplier">
            <select id="owz-confirm-supplier" className="i2-select" value={supplierKey} onChange={(e) => selectSupplier(e.target.value)}>
              <option value="">ללא ספק</option>
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

          <h3 className="i2-h3">סיכום ההזמנה</h3>
          <div className="i2-box">
            <ul className="i2-list">
              {selectedItems.map((item) => (
                <li key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--i2-line-strong)" }}>
                  <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{item.name}</span>
                  <span className="i2-num" style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
                    {qtyWithUnit(order[item.id] ?? 0, item.unitType)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <InvNote>יצירת ההזמנה לא תשנה את המלאי ולא תשלח הודעה לספק.</InvNote>
        </>
      )}

      {confirming ? (
        <InvConfirm
          title="ליצור את ההזמנה?"
          body="ההזמנה תישמר כטיוטה שממתינה לקליטה. אפשר לשתף אותה עם הספק במסך הבא."
          confirmLabel={actionLoading ? "יוצרים…" : "צור הזמנה"}
          busy={actionLoading}
          onConfirm={() => {
            setConfirming(false);
            void createOrder();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </OrderWizardShell>
  );
}
