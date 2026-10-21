"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function CustomersIndexPage() {
  const { t } = useI18n();
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
          <path d="M16 5.2a3.2 3.2 0 0 1 0 5.9M17.5 19a5.5 5.5 0 0 0-2.7-4.7" strokeLinecap="round" />
        </svg>
      }
      title={t("customers.customer.desk.title")}
      description={t("customers.customer.desk.description")}
      lead={t("customers.customer.desk.lead")}
      facts={[
        { title: t("customers.customer.desk.contactTitle"), body: t("customers.customer.desk.contactBody") },
        { title: t("customers.customer.desk.notesTitle"), body: t("customers.customer.desk.notesBody") },
        { title: t("customers.customer.desk.activityTitle"), body: t("customers.customer.desk.activityBody") },
      ]}
    />
  );
}
