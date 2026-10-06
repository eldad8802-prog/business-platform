"use client";

import { useEffect, useState } from "react";

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
          <h1 className={styles.pageTitle}>המלצות Dubiz</h1>
        </div>
        <p className={styles.lead}>
          Dubiz מסתכל על מה שקורה בעסק ומציע דברים שכדאי לטפל בהם. כל המלצה מסבירה על מה היא מבוססת, וההחלטה תמיד שלך.
        </p>

        {failed ? (
          <p className={`${styles.message} ${styles.messageError}`} role="alert">לא הצלחנו לטעון את ההמלצות. נסה שוב בעוד רגע.</p>
        ) : data === null ? (
          <p className={styles.lead} aria-live="polite">טוען…</p>
        ) : !data.enabled ? (
          <div className={styles.empty}>המלצות Dubiz עדיין לא פעילות בעסק שלך.</div>
        ) : data.items.length === 0 ? (
          <div className={styles.empty}>אין כרגע המלצות. כש־Dubiz יזהה משהו שכדאי לטפל בו, זה יופיע כאן.</div>
        ) : (
          <>
            <Group title="מחכות להחלטה שלך" items={data.items.filter((v) => v.stage === "waiting")} />
            <Group title="בטיפול" items={data.items.filter((v) => v.stage === "in_progress")} />
            <Group title="מה כבר קרה" items={data.items.filter((v) => v.stage === "closed")} />
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
