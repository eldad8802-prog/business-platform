"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { InventoryRow, InventoryBadge, ConfirmModal } from "@/components/inventory/inventory-design";
import { useI18n } from "@/components/i18n/I18nProvider";

function ConnectButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 38,
        padding: "0 16px",
        borderRadius: 11,
        border: "1px solid var(--inv-accent)",
        background: "var(--inv-accent)",
        color: "var(--inv-on-accent)",
        fontFamily: "inherit",
        fontWeight: 600,
        fontSize: 13.5,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

export default function SupplierPurchasesIntegrationsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [comingSoon, setComingSoon] = useState(false);

  return (
    <InventorySubPage intent="standard"
      title={t("customers.purchases.integrations.title")}
      variant="hub"
      hubBack
      sub={t("customers.purchases.integrations.sub")}
      bottomNav="orders"
    >
      <div className="inv-desk-workspace inv-ops">
      <div className="inv-rows">
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🧾</span>}
          title={t("customers.purchases.integrations.posTitle")}
          meta={t("customers.purchases.integrations.posMeta")}
          trail={<ConnectButton label={t("customers.purchases.integrations.connect")} onClick={() => setComingSoon(true)} />}
        />
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>📄</span>}
          title={t("customers.purchases.integrations.csvTitle")}
          meta={t("customers.purchases.integrations.csvMeta")}
          trail={<ConnectButton label={t("customers.purchases.integrations.import")} onClick={() => router.push("/inventory/supplier-purchases/import")} />}
        />
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🔌</span>}
          title={t("customers.purchases.integrations.apiTitle")}
          meta={t("customers.purchases.integrations.apiMeta")}
          trail={<InventoryBadge tone="neutral">{t("customers.purchases.integrations.comingSoon")}</InventoryBadge>}
          onClick={() => setComingSoon(true)}
        />
      </div>
      <aside className="inv-ops__side">
        <h2>{t("customers.purchases.integrations.sideTitle")}</h2>
        <p>{t("customers.purchases.integrations.sideBody1")}</p>
        <p>{t("customers.purchases.integrations.sideBody2")}</p>
      </aside>
      </div>

      {comingSoon ? (
        <ConfirmModal
          title={t("customers.purchases.integrations.modalTitle")}
          body={t("customers.purchases.integrations.modalBody")}
          confirmLabel={t("customers.purchases.integrations.gotIt")}
          cancelLabel={t("customers.purchases.integrations.close")}
          onConfirm={() => setComingSoon(false)}
          onCancel={() => setComingSoon(false)}
        />
      ) : null}
    </InventorySubPage>
  );
}
