"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function LeadsIndexPage() {
  const { t } = useI18n();
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
        </svg>
      }
      title={t("customers.leads.desk.title")}
      description={t("customers.leads.desk.description")}
      lead={t("customers.leads.desk.lead")}
      facts={[
        { title: t("customers.leads.desk.requestTitle"), body: t("customers.leads.desk.requestBody") },
        { title: t("customers.leads.desk.followUpTitle"), body: t("customers.leads.desk.followUpBody") },
        { title: t("customers.leads.desk.historyTitle"), body: t("customers.leads.desk.historyBody") },
      ]}
    />
  );
}
