"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";
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
  const { t, locale } = useI18n();
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
      title={t("customers.purchases.cart.title")}
      backHref="/inventory/supplier-purchases/new"
      showProgress={true}
      footer={
        hasItems ? (
          <div className="inv-decision-mobile">
            <BottomActionBar
              label={t(
                summary.totalUnits === 1 ? "customers.purchases.cart.orderTotalOne" : "customers.purchases.cart.orderTotalMany",
                { count: summary.totalUnits }
              )}
              value={total > 0 ? <>₪{total.toLocaleString(intlTag(locale))}</> : "—"}
              cta={t("customers.purchases.cart.continueToConfirm")}
              onCta={() => router.push("/inventory/supplier-purchases/new/confirm")}
            />
          </div>
        ) : null
      }
    >
      {!hasItems ? (
        <div className="inv-page-content" style={{ padding: "8px clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={t("customers.purchases.cart.emptyTitle")}
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => router.push("/inventory/supplier-purchases/new")}>
                {t("customers.purchases.cart.selectProducts")}
              </button>
            }
          >
            {t("customers.purchases.cart.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label={t("customers.purchases.cart.linesAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.purchases.cart.colProduct")}</th>
                <th>{t("customers.purchases.cart.colQuantity")}</th>
                <th>{t("customers.purchases.cart.colUnitCost")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {selectedItems.map((item) => {
                const qty = order[item.id] ?? 0;
                return (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>
                      <button type="button" onClick={() => decrementItem(item.id)} aria-label={t("customers.purchases.cart.decrease")}>−</button>
                      {" "}{qty}{" "}
                      <button type="button" onClick={() => incrementItem(item.id)} aria-label={t("customers.purchases.cart.increase")}>+</button>
                    </td>
                    <td>
                      <input
                        className="inv-input"
                        style={{ minHeight: 36 }}
                        inputMode="decimal"
                        placeholder={t("customers.purchases.cart.optional")}
                        value={unitCosts[item.id] ?? ""}
                        onChange={(e) => setUnitCost(item.id, e.target.value)}
                        aria-label={t("customers.purchases.cart.unitCostFor", { name: item.name })}
                      />
                    </td>
                    <td>
                      <button type="button" onClick={() => removeItem(item.id)} aria-label={t("customers.purchases.cart.removeNamed", { name: item.name })}>{t("customers.purchases.cart.remove")}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="inv-olines inv-decision-mobile">
          {selectedItems.map((item) => {
            const qty = order[item.id] ?? 0;
            return (
              <InventoryOrderLine
                key={item.id}
                thumb={<span style={{ fontSize: 22 }}>{getProductEmoji(item.name)}</span>}
                name={item.name}
                sub={isSuggested(item.id) ? t("customers.purchases.cart.systemSuggestion") : item.unitType}
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
                      placeholder={t("customers.purchases.cart.unitCostOptional")}
                      value={unitCosts[item.id] ?? ""}
                      onChange={(e) => setUnitCost(item.id, e.target.value)}
                      aria-label={t("customers.purchases.cart.unitCostFor", { name: item.name })}
                    />
                    <button type="button" className="inv-oline__remove" onClick={() => removeItem(item.id)} aria-label={t("customers.purchases.cart.removeNamed", { name: item.name })}>
                      ×
                    </button>
                  </div>
                }
              />
            );
          })}
          <button type="button" className="inv-btn-link" style={{ marginInlineStart: "auto" }} onClick={clearOrder}>
            {t("customers.purchases.cart.clearCart")}
          </button>
        </div>
        <aside className="inv-ops__side">
          <h2>{t("customers.purchases.cart.sideTitle")}</h2>
          <p>
            {t(
              summary.totalItems === 1 ? "customers.purchases.common.productsOne" : "customers.purchases.common.productsMany",
              { count: summary.totalItems }
            )}{" "}
            ·{" "}
            {t(
              summary.totalUnits === 1 ? "customers.purchases.common.unitsOne" : "customers.purchases.common.unitsMany",
              { count: summary.totalUnits }
            )}
          </p>
          <p>
            {total > 0 ? (
              <>
                {t("customers.purchases.cart.totalLabel")} <bdi>₪{total.toLocaleString(intlTag(locale))}</bdi>
              </>
            ) : (
              t("customers.purchases.cart.noCostYet")
            )}
          </p>
          <p>{t("customers.purchases.cart.sideNote")}</p>
          <button type="button" className="inv-btn-primary" style={{ width: "100%" }} onClick={() => router.push("/inventory/supplier-purchases/new/confirm")}>
            {t("customers.purchases.cart.continueToConfirm")}
          </button>
          <button type="button" className="inv-btn-link" onClick={clearOrder}>{t("customers.purchases.cart.clearCart")}</button>
        </aside>
        </div>
      )}
    </OrderWizardShell>
  );
}
