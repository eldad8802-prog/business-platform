"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import PageHeader from "@/components/ui/page-header";
import { LandingStrategyPreview } from "@/components/business/landing/LandingStrategyPreview";
import styles from "../identity/identity-page.module.css";

/**
 * P3-B — preview of the landing-page directions Dubiz would build on (strategy only: no page, no copy).
 */
export default function LandingStrategyPage() {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title={t("content.identity.strategy.pageTitle")} backHref="/business/identity" backLabel={t("content.identity.strategy.back")} showBack />
      <main className={styles.main}>
        <p className={styles.intro}>
          {t("content.identity.strategy.intro")}
        </p>
        <div style={{ marginTop: 16 }}>
          <LandingStrategyPreview />
        </div>
      </main>
    </div>
  );
}
