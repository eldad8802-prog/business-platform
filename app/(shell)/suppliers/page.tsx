"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function SuppliersIndexPage() {
  const { t } = useI18n();
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M3 7.5 12 3l9 4.5M5 9.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 20v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
      title={t("customers.suppliers.index.title")}
      description={t("customers.suppliers.index.description")}
      lead={t("customers.suppliers.index.lead")}
      facts={[
        { title: t("customers.suppliers.index.contactTitle"), body: t("customers.suppliers.index.contactBody") },
        { title: t("customers.suppliers.index.ordersTitle"), body: t("customers.suppliers.index.ordersBody") },
        { title: t("customers.suppliers.index.activityTitle"), body: t("customers.suppliers.index.activityBody") },
      ]}
    />
  );
}
