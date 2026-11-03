"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { I2, InvButton, InvConfirm, InvPage, InvPill, InvRow, InvStatus, ProductThumb } from "@/components/inventory/v2/kit";

/**
 * Supplier-order integrations (restyled on the inventory v2 kit; same content as before):
 * POS → "next stage" notice only, CSV → the import screen, API → coming soon.
 * Nothing here connects or activates anything.
 */
export default function SupplierPurchasesIntegrationsPage() {
  const { t } = useI18n();
  const [comingSoon, setComingSoon] = useState(false);

  const icon = (node: React.ReactNode) => (
    <span className="i2-thumb" style={{ ["--s" as string]: "48px" } as React.CSSProperties} aria-hidden>
      {node}
    </span>
  );

  return (
    <InvPage title={t("customers.purchases.integrations.title")} backFallback="/inventory/supplier-purchases">
      <p className="i2-muted" style={{ margin: "4px 0 8px" }}>{t("customers.purchases.integrations.sub")}</p>
      <ul className="i2-list">
        <InvRow
          thumb={icon(I2.list(24))}
          title={t("customers.purchases.integrations.posTitle")}
          sub={t("customers.purchases.integrations.posMeta")}
          trail={<InvPill outline onClick={() => setComingSoon(true)}>{t("customers.purchases.integrations.connect")}</InvPill>}
        />
        <InvRow
          thumb={icon(I2.file(24))}
          title={t("customers.purchases.integrations.csvTitle")}
          sub={t("customers.purchases.integrations.csvMeta")}
          trail={<InvPill href="/inventory/supplier-purchases/import">{t("customers.purchases.integrations.import")}</InvPill>}
        />
        <InvRow
          thumb={<ProductThumb name="API" size={48} />}
          title={t("customers.purchases.integrations.apiTitle")}
          sub={t("customers.purchases.integrations.apiMeta")}
          onClick={() => setComingSoon(true)}
          trail={<InvStatus>{t("customers.purchases.integrations.comingSoon")}</InvStatus>}
        />
      </ul>
      <div className="i2-note">
        {I2.info(20)}
        <div>
          <p style={{ margin: 0 }}>{t("customers.purchases.integrations.sideBody1")}</p>
          <p style={{ margin: "6px 0 0" }}>{t("customers.purchases.integrations.sideBody2")}</p>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <InvButton kind="secondary" block href="/inventory/supplier-purchases">
          חזרה להזמנות
        </InvButton>
      </div>

      {comingSoon ? (
        <InvConfirm
          title={t("customers.purchases.integrations.modalTitle")}
          body={t("customers.purchases.integrations.modalBody")}
          confirmLabel={t("customers.purchases.integrations.gotIt")}
          cancelLabel={t("customers.purchases.integrations.close")}
          onConfirm={() => setComingSoon(false)}
          onCancel={() => setComingSoon(false)}
        />
      ) : null}
    </InvPage>
  );
}
