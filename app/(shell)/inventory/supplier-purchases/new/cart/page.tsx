"use client";

import { useRouter } from "next/navigation";
import { useOrderWizard } from "@/components/inventory/supplier-purchase-order/order-wizard-context";
import { OrderWizardShell } from "@/components/inventory/supplier-purchase-order/order-wizard-shell";
import {
  InventoryOrderLine,
  MiniStepper,
  BottomActionBar,
  InventoryStatePanel,
} from "@/components/inventory/inventory-design";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

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

  const total = selectedItems.reduce((sum, item) => {
    const qty = order[item.id] ?? 0;
    const cost = Number(unitCosts[item.id] ?? "");
    return sum + (Number.isFinite(cost) ? qty * cost : 0);
  }, 0);

  return (
    <OrderWizardShell
      title="הזמנת רכש"
      backHref="/inventory/supplier-purchases/new"
      showProgress={true}
      footer={
        hasItems ? (
          <BottomActionBar
            label={`סה״כ הזמנה (${summary.totalUnits} יחידות)`}
            value={total > 0 ? <>₪{total.toLocaleString("he-IL")}</> : "—"}
            cta="המשך לאישור"
            onCta={() => router.push("/inventory/supplier-purchases/new/confirm")}
          />
        ) : null
      }
    >
      {!hasItems ? (
        <div className="inv-page-content" style={{ padding: "8px clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title="העגלה ריקה"
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => router.push("/inventory/supplier-purchases/new")}>
                בחירת מוצרים
              </button>
            }
          >
            חזרו לבחירת מוצרים כדי להתחיל הזמנה.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-olines">
          {selectedItems.map((item) => {
            const qty = order[item.id] ?? 0;
            return (
              <InventoryOrderLine
                key={item.id}
                thumb={<span style={{ fontSize: 22 }}>{getProductEmoji(item.name)}</span>}
                name={item.name}
                sub={isSuggested(item.id) ? "המלצת מערכת" : item.unitType}
                trailing={
                  <MiniStepper
                    value={qty}
                    min={0}
                    onDecrement={() => decrementItem(item.id)}
                    onIncrement={() => incrementItem(item.id)}
                  />
                }
                extra={
                  <div style={{ width: "100%", display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      className="inv-input"
                      style={{ minHeight: 40, flex: 1 }}
                      inputMode="decimal"
                      placeholder="עלות ליחידה (לא חובה)"
                      value={unitCosts[item.id] ?? ""}
                      onChange={(e) => setUnitCost(item.id, e.target.value)}
                      aria-label={`עלות ליחידה עבור ${item.name}`}
                    />
                    <button type="button" className="inv-oline__remove" onClick={() => removeItem(item.id)} aria-label={`הסר ${item.name}`}>
                      ×
                    </button>
                  </div>
                }
              />
            );
          })}
          <button type="button" className="inv-btn-link" style={{ marginInlineStart: "auto" }} onClick={clearOrder}>
            נקה עגלה
          </button>
        </div>
      )}
    </OrderWizardShell>
  );
}
