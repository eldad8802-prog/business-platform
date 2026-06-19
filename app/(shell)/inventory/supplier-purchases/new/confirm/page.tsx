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
    setSupplierName,
    supplierOptions,
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
          <BottomActionBar
            secondary={{ label: "שמור טיוטה", onClick: persistDraft }}
            label=""
            value=""
            cta={actionLoading ? "שולח…" : supplierName ? `שלח הזמנה ל${supplierName}` : "צור הזמנה"}
            ctaDisabled={!canSubmit}
            onCta={() => setConfirming(true)}
          />
        ) : null
      }
    >
      <div className="inv-fwrap">
        <div className="inv-field">
          <div className="inv-field__lab">ספק</div>
          <select className="inv-input" value={supplierName} onChange={(e) => setSupplierName(e.target.value)}>
            <option value="">ללא ספק</option>
            {supplierOptions.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
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
        <div className="inv-olines">
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
      )}

      <p className="inv-field__help" style={{ maxWidth: 720, margin: "8px auto 0", padding: "0 clamp(16px,3.5vw,28px)" }}>
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
