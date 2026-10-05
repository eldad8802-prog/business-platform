"use client";

import PageHeader from "@/components/ui/page-header";
import { BusinessIdentityEditor } from "@/components/business/identity/BusinessIdentityEditor";
import { TrustConversionPanel } from "@/components/business/identity/TrustConversionPanel";
import styles from "./identity-page.module.css";

/**
 * P2 + P3-A — who the business is (owner statements and public facts), how customers can reach it
 * (conversion) and what Dubiz may say about it (trust). The canonical screen for identity.
 */
export default function BusinessIdentityPage() {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title="איך העסק מוצג" backHref="/business" backLabel="חזרה" showBack />
      <main className={styles.main}>
        <p className={styles.intro}>
          כמה דברים שרק אתה יודע על העסק — כדי ש-Dubiz ידבר בשמו נכון. הכול אופציונלי, ואפשר לשנות בכל רגע.
          שום דבר לא יוצג ללקוחות בלי שסימנת &quot;מאושר לשימוש פומבי&quot;.
        </p>
        <div className={styles.layout}>
          <div className={styles.column}>
            <BusinessIdentityEditor />
          </div>
          <div className={styles.column}>
            <TrustConversionPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
