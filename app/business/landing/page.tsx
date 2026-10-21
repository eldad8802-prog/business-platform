"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import PageHeader from "@/components/ui/page-header";
import { LandingVersionsScreen } from "@/components/business/landing/LandingVersionsScreen";
import styles from "../identity/identity-page.module.css";

/**
 * P3-E — the owner's landing page versions: approved version, current draft, history, preview, approve,
 * restore. Owner only; nothing here is published.
 */
export default function LandingVersionsPage() {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title={t("content.identity.versions.pageTitle")} backHref="/business/identity" backLabel={t("content.identity.versions.back")} showBack />
      <main className={styles.main}>
        <LandingVersionsScreen />
      </main>
    </div>
  );
}
