"use client";

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";
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
  const { t, locale } = useI18n();
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
  const tag = intlTag(locale);
  const countsLine = `${t(
    summary.totalItems === 1 ? "customers.purchases.common.productsOne" : "customers.purchases.common.productsMany",
    { count: summary.totalItems }
  )} · ${t(
    summary.totalUnits === 1 ? "customers.purchases.common.unitsOne" : "customers.purchases.common.unitsMany",
    { count: summary.totalUnits }
  )}`;
  const submitLabel = actionLoading
    ? t("customers.purchases.confirm.sending")
    : supplierName
      ? t("customers.purchases.confirm.sendTo", { name: supplierName })
      : t("customers.purchases.confirm.createOrder");
  const supplierHelp = supplierKey.startsWith("id:")
    ? t("customers.purchases.confirm.supplierLinkedHelp")
    : t("customers.purchases.confirm.supplierPickHelp");

  return (
    <OrderWizardShell
      title={t("customers.purchases.confirm.title")}
      backHref="/inventory/supplier-purchases/new/cart"
      showProgress={true}
      footer={
        selectedItems.length > 0 ? (
          <div className="inv-decision-mobile">
            <BottomActionBar
              secondary={{ label: t("customers.purchases.confirm.saveDraft"), onClick: persistDraft }}
              label=""
              value=""
              cta={submitLabel}
              ctaDisabled={!canSubmit}
              onCta={() => setConfirming(true)}
            />
          </div>
        ) : null
      }
    >
      <div className="inv-fwrap inv-decision-mobile">
        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.purchases.confirm.supplier")}</div>
          <select
            className="inv-input"
            value={supplierKey}
            onChange={(e) => selectSupplier(e.target.value)}
          >
            <option value="">{t("customers.purchases.confirm.noSupplier")}</option>
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
            {supplierHelp}
          </p>
        </div>
      </div>

      <div className="inv-seclabel">{t("customers.purchases.confirm.itemsInOrder")}</div>

      {selectedItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={t("customers.purchases.confirm.emptyTitle")}
            action={<Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">{t("customers.purchases.confirm.backToSelect")}</Link>}
          />
        </div>
      ) : (
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label={t("customers.purchases.confirm.tableAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.purchases.confirm.colProduct")}</th>
                <th>{t("customers.purchases.confirm.colQuantity")}</th>
                <th>{t("customers.purchases.confirm.colCost")}</th>
                <th>{t("customers.purchases.confirm.colTotal")}</th>
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
                    <td className="num">{hasCost ? `₪${(qty * cost).toLocaleString(tag)}` : "—"}</td>
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
                sub={hasCost ? <><bdi>{qty}</bdi> × <bdi>₪{cost}</bdi></> : <><bdi>{qty}</bdi> {t("customers.purchases.confirm.unitsNoCost")}</>}
                trailing={hasCost ? <span className="inv-oline__price"><bdi>₪{(qty * cost).toLocaleString(tag)}</bdi></span> : null}
              />
            );
          })}
        </div>
        <aside className="inv-ops__side">
          <h2>{t("customers.purchases.confirm.beforeSending")}</h2>
          <label className="inv-field" style={{ marginTop: 0 }}>
            <span className="inv-field__lab">{t("customers.purchases.confirm.supplier")}</span>
            <select
              className="inv-input"
              value={supplierKey}
              onChange={(e) => selectSupplier(e.target.value)}
            >
              <option value="">{t("customers.purchases.confirm.noSupplier")}</option>
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
            {supplierHelp}
          </p>
          <p>{countsLine}{total > 0 ? <> · <bdi>₪{total.toLocaleString(tag)}</bdi></> : null}</p>
          <p>{t("customers.purchases.confirm.stockNote")}</p>
          <button type="button" className="inv-btn-primary" style={{ width: "100%" }} disabled={!canSubmit} onClick={() => setConfirming(true)}>
            {submitLabel}
          </button>
          <button type="button" className="inv-sheet__ghost" style={{ width: "100%", minHeight: 44 }} onClick={persistDraft}>
            {t("customers.purchases.confirm.saveDraft")}
          </button>
        </aside>
        </div>
      )}

      <p className="inv-field__help inv-decision-mobile" style={{ maxWidth: 720, margin: "8px auto 0", padding: "0 clamp(16px,3.5vw,28px)" }}>
        {t("customers.purchases.confirm.stockNote")}
      </p>

      {confirming ? (
        <ConfirmModal
          title={
            supplierName
              ? t("customers.purchases.confirm.modalTitleTo", { name: supplierName })
              : t("customers.purchases.confirm.modalTitle")
          }
          body={`${countsLine}${total > 0 ? ` · ₪${total.toLocaleString(tag)}` : ""}`}
          confirmLabel={actionLoading ? t("customers.purchases.confirm.sending") : t("customers.purchases.confirm.confirmAndSend")}
          onConfirm={() => void createOrder()}
          onCancel={() => setConfirming(false)}
          confirmDisabled={!canSubmit}
        />
      ) : null}
    </OrderWizardShell>
  );
}
