"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
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
  const { t } = useI18n();
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
      title={t("customers.purchases.newOrder.title")}
      backHref="/inventory/supplier-purchases"
      showProgress={true}
      footer={
        <BottomActionBar
          label={t(
            summary.totalItems === 1
              ? "customers.purchases.newOrder.productsInCartOne"
              : "customers.purchases.newOrder.productsInCartMany",
            { count: summary.totalItems }
          )}
          value={
            <>
              {t(
                summary.totalUnits === 1 ? "customers.purchases.common.unitsOne" : "customers.purchases.common.unitsMany",
                { count: summary.totalUnits }
              )}
            </>
          }
          cta={t("customers.purchases.newOrder.continueToCartCount", { count: summary.totalItems })}
          ctaDisabled={!canContinue}
          onCta={() => router.push("/inventory/supplier-purchases/new/cart")}
        />
      }
    >
      <InventorySearch value={productSearch} onChange={setProductSearch} placeholder={t("customers.purchases.newOrder.searchPlaceholder")} />

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
              aria-label={t("customers.purchases.newOrder.supplierAria")}
            >
              <option value="">{t("customers.purchases.newOrder.allSuppliers")}</option>
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
              aria-label={t("customers.purchases.newOrder.categoryAria")}
            >
              <option value="">{t("customers.purchases.newOrder.allCategories")}</option>
              {filteredCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {browsableItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={t("customers.purchases.newOrder.emptyTitle")}>
            {supplierName.trim() && !supplierHasItems
              ? t("customers.purchases.newOrder.emptySupplier")
              : t("customers.purchases.newOrder.emptySearch")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
          <div className="inv-desk-table" aria-label={t("customers.purchases.newOrder.tableAria")}>
            <table>
              <thead>
                <tr>
                  <th>{t("customers.purchases.newOrder.colProduct")}</th>
                  <th>{t("customers.purchases.newOrder.colCategory")}</th>
                  <th>{t("customers.purchases.newOrder.colInStock")}</th>
                  <th>{t("customers.purchases.newOrder.colInCart")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {browsableItems.map((item) => {
                  const inCart = order[item.id] ?? 0;
                  return (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{getCategoryName(item)}</td>
                      <td className="num">{item.currentQuantity}</td>
                      <td className="num">{inCart || "—"}</td>
                      <td>
                        <button type="button" onClick={() => quickAddItem(item)}>{t("customers.purchases.newOrder.add")}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <aside className="inv-ops__side">
            <h2>{t("customers.purchases.newOrder.sideTitle")}</h2>
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
            <p>{t("customers.purchases.newOrder.sideNote")}</p>
            <button type="button" className="inv-btn-primary" disabled={!canContinue} onClick={() => router.push("/inventory/supplier-purchases/new/cart")}>
              {t("customers.purchases.newOrder.continueToCart")}
            </button>
          </aside>
        </div>
        <div className="inv-rows inv-cards">
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
                    {getCategoryName(item)} · {t("customers.purchases.newOrder.inStockLabel")} <bdi>{item.currentQuantity}</bdi>
                  </span>
                </span>
                <span className="inv-row__trail" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {inCart > 0 ? <span className="inv-row__meta">{t("customers.purchases.newOrder.inCartCount", { count: inCart })}</span> : null}
                  <button
                    type="button"
                    className="inv-iconbtn inv-iconbtn--acc"
                    style={{ width: 38, height: 38 }}
                    onClick={() => quickAddItem(item)}
                    aria-label={t("customers.purchases.newOrder.addNamed", { name: item.name })}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 5v14M5 12h14" stroke="var(--inv-on-accent)" strokeWidth="2.4" strokeLinecap="round" /></svg>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        </>
      )}
    </OrderWizardShell>
  );
}
