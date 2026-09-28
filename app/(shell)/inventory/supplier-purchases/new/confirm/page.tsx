"use client";

import { useState } from "react";
import Link from "next/link";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import {
  InventoryOrderLine,
  BottomActionBar,
  ConfirmModal,
  InventoryStatePanel,
} from "@/components/inventory/inventory-design";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

export default function NewSupplierPurchaseConfirmPage() {
  const {
    summary,
    selectedItems,
    order,
    unitCosts,
    supplierName,
    supplierKey,
    selectSupplier,
    supplierChoices,
    createOrder,
    actionLoading,
    persistDraft,
  } = useOrderWizard();
  const [confirming, setConfirming] = useState(false);

  const canSubmit = summary.totalItems > 0 && !actionLoading;
  const total = selectedItems.reduce((sum, item) => {
    const qty = order[item.id] ?? 0;
    const cost = Number(unitCosts[item.id] ?? "");
    return sum + (Number.isFinite(cost) ? qty * cost : 0);
  }, 0);

  return (
    <OrderWizardShell
      title="אישור הזמנה"
      backHref="/inventory/supplier-purchases/new/cart"
      showProgress={true}
      footer={
        selectedItems.length > 0 ? (
          <div className="inv-decision-mobile">
            <BottomActionBar
              secondary={{ label: "שמור טיוטה", onClick: persistDraft }}
              label=""
              value=""
              cta={actionLoading ? "שולח…" : supplierName ? `שלח הזמנה ל${supplierName}` : "צור הזמנה"}
              ctaDisabled={!canSubmit}
              onCta={() => setConfirming(true)}
            />
          </div>
        ) : null
      }
    >
      <div className="inv-fwrap inv-decision-mobile">
        <div className="inv-field">
          <div className="inv-field__lab">ספק</div>
          <select
            className="inv-input"
            value={supplierKey}
            onChange={(e) => selectSupplier(e.target.value)}
          >
            <option value="">ללא ספק</option>
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
          <p className="inv-field__help">
            {supplierKey.startsWith("id:")
              ? "ההזמנה תישמר על כרטיס הספק הזה ותופיע בהיסטוריית הרכש שלו."
              : "בחירת ספק מהרשימה תקשר את ההזמנה לכרטיס הספק."}
          </p>
        </div>
      </div>

      <div className="inv-seclabel">פריטים בהזמנה</div>

      {selectedItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title="אין פריטים בהזמנה"
            action={<Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">חזרה לבחירת מוצרים</Link>}
          />
        </div>
      ) : (
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label="פריטים לאישור">
          <table>
            <thead>
              <tr>
                <th>מוצר</th>
                <th>כמות</th>
                <th>עלות</th>
                <th>סה״כ</th>
              </tr>
            </thead>
            <tbody>
              {selectedItems.map((item) => {
                const qty = order[item.id] ?? 0;
                const cost = Number(unitCosts[item.id] ?? "");
                const hasCost = Number.isFinite(cost) && (unitCosts[item.id] ?? "").trim() !== "";
                return (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td className="num">{qty}</td>
                    <td className="num">{hasCost ? `₪${cost}` : "—"}</td>
                    <td className="num">{hasCost ? `₪${(qty * cost).toLocaleString("he-IL")}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="inv-olines inv-decision-mobile">
          {selectedItems.map((item) => {
            const qty = order[item.id] ?? 0;
            const cost = Number(unitCosts[item.id] ?? "");
            const hasCost = Number.isFinite(cost) && (unitCosts[item.id] ?? "").trim() !== "";
            return (
              <InventoryOrderLine
                key={item.id}
                thumb={<span style={{ fontSize: 22 }}>{getProductEmoji(item.name)}</span>}
                name={item.name}
                sub={hasCost ? <><bdi>{qty}</bdi> × <bdi>₪{cost}</bdi></> : <><bdi>{qty}</bdi> יחידות · עלות לא צוינה</>}
                trailing={hasCost ? <span className="inv-oline__price"><bdi>₪{(qty * cost).toLocaleString("he-IL")}</bdi></span> : null}
              />
            );
          })}
        </div>
        <aside className="inv-ops__side">
          <h2>לפני שליחה</h2>
          <label className="inv-field" style={{ marginTop: 0 }}>
            <span className="inv-field__lab">ספק</span>
            <select
              className="inv-input"
              value={supplierKey}
              onChange={(e) => selectSupplier(e.target.value)}
            >
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
          </label>
          <p>
            {supplierKey.startsWith("id:")
              ? "ההזמנה תישמר על כרטיס הספק הזה ותופיע בהיסטוריית הרכש שלו."
              : "בחירת ספק מהרשימה תקשר את ההזמנה לכרטיס הספק."}
          </p>
          <p>{summary.totalItems} מוצרים · {summary.totalUnits} יחידות{total > 0 ? <> · <bdi>₪{total.toLocaleString("he-IL")}</bdi></> : null}</p>
          <p>המלאי יתעדכן רק לאחר קליטת הסחורה בפועל. יצירת ההזמנה לא משנה מלאי.</p>
          <button type="button" className="inv-btn-primary" style={{ width: "100%" }} disabled={!canSubmit} onClick={() => setConfirming(true)}>
            {actionLoading ? "שולח…" : supplierName ? `שלח הזמנה ל${supplierName}` : "צור הזמנה"}
          </button>
          <button type="button" className="inv-sheet__ghost" style={{ width: "100%", minHeight: 44 }} onClick={persistDraft}>
            שמור טיוטה
          </button>
        </aside>
        </div>
      )}

      <p className="inv-field__help inv-decision-mobile" style={{ maxWidth: 720, margin: "8px auto 0", padding: "0 clamp(16px,3.5vw,28px)" }}>
        המלאי יתעדכן רק לאחר קליטת הסחורה בפועל. יצירת ההזמנה לא משנה מלאי.
      </p>

      {confirming ? (
        <ConfirmModal
          title={supplierName ? `לשלוח הזמנה ל${supplierName}?` : "ליצור הזמנה?"}
          body={`${summary.totalItems} מוצרים · ${summary.totalUnits} יחידות${total > 0 ? ` · ₪${total.toLocaleString("he-IL")}` : ""}`}
          confirmLabel={actionLoading ? "שולח…" : "אישור ושליחה"}
          onConfirm={() => void createOrder()}
          onCancel={() => setConfirming(false)}
          confirmDisabled={!canSubmit}
        />
      ) : null}
    </OrderWizardShell>
  );
}
