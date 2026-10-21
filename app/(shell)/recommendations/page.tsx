"use client";

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import BackButton from "@/components/ui/back-button";
import { PageContainer } from "@/components/ui/page-container";
import { RecommendationRow } from "@/features/recommendations/recommendation-parts";
import { loadRecommendations, type RecommendationsPayload, type RecommendationView } from "@/features/recommendations/recommendations-client";
import styles from "@/features/recommendations/recommendations.module.css";

/**
 * Dubiz recommendations — everything Dubiz suggested, grouped by what it needs from the owner: an answer,
 * work in progress, and what already happened. Reached from the Home card ("Dubiz ממליץ").
 */
export default function RecommendationsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<RecommendationsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadRecommendations().then(
      (p) => { if (!cancelled) setData(p); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <PageContainer intent="standard">
      <div className={styles.page}>
        <div className={styles.topRow}>
          <BackButton />
          <h1 className={styles.pageTitle}>{t("home.recommendations.title")}</h1>
        </div>
        <p className={styles.lead}>
          {t("home.recommendations.lead")}
        </p>

        {failed ? (
          <p className={`${styles.message} ${styles.messageError}`} role="alert">{t("home.recommendations.loadFailed")}</p>
        ) : data === null ? (
          <p className={styles.lead} aria-live="polite">{t("home.recommendations.loading")}</p>
        ) : !data.enabled ? (
          <div className={styles.empty}>{t("home.recommendations.disabled")}</div>
        ) : data.items.length === 0 ? (
          <div className={styles.empty}>{t("home.recommendations.empty")}</div>
        ) : (
          <>
            <Group title={t("home.recommendations.groupWaiting")} items={data.items.filter((v) => v.stage === "waiting")} />
            <Group title={t("home.recommendations.groupInProgress")} items={data.items.filter((v) => v.stage === "in_progress")} />
            <Group title={t("home.recommendations.groupClosed")} items={data.items.filter((v) => v.stage === "closed")} />
          </>
        )}
      </div>
    </PageContainer>
  );
}

function Group({ title, items }: { title: string; items: RecommendationView[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className={styles.sectionTitle}>
        {title} <span className={styles.count}>{items.length}</span>
      </h2>
      <ul className={styles.list}>
        {items.map((v) => <RecommendationRow key={v.id} view={v} />)}
      </ul>
    </section>
  );
}
