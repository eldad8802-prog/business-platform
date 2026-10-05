"use client";

import PageHeader from "@/components/ui/page-header";
import { LandingStrategyPreview } from "@/components/business/landing/LandingStrategyPreview";
import styles from "../identity/identity-page.module.css";

/**
 * P3-B — preview of the landing-page directions Dubiz would build on (strategy only: no page, no copy).
 */
export default function LandingStrategyPage() {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title="כיווני דף נחיתה" backHref="/business/identity" backLabel="חזרה" showBack />
      <main className={styles.main}>
        <p className={styles.intro}>
          לפי מה שידוע על העסק, אלה הכיוונים השונים שדוביז יכולה להציע לדף נחיתה — כל אחד עם מטרה, דרך פנייה ומיקוד משלו.
        </p>
        <div style={{ marginTop: 16 }}>
          <LandingStrategyPreview />
        </div>
      </main>
    </div>
  );
}
