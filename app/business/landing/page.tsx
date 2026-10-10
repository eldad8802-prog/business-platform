"use client";

import PageHeader from "@/components/ui/page-header";
import { LandingVersionsScreen } from "@/components/business/landing/LandingVersionsScreen";
import styles from "../identity/identity-page.module.css";

/**
 * P3-E — the owner's landing page versions: approved version, current draft, history, preview, approve,
 * restore. Owner only; nothing here is published.
 */
export default function LandingVersionsPage() {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title="גרסאות הדף" backHref="/business/identity" backLabel="חזרה" showBack />
      <main className={styles.main}>
        <LandingVersionsScreen />
      </main>
    </div>
  );
}
