"use client";

import PageHeader from "@/components/ui/page-header";
import { BusinessIdentityEditor } from "@/components/business/identity/BusinessIdentityEditor";

/** P2 — who the business is, in the owner's words. The canonical screen for identity + positioning. */
export default function BusinessIdentityPage() {
  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title="איך העסק מוצג" backHref="/business" backLabel="חזרה" showBack />
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "16px 16px 48px" }}>
        <p style={{ fontSize: 14, color: "var(--dz-text-muted)", margin: 0, lineHeight: 1.6 }}>
          כמה דברים שרק אתה יודע על העסק — כדי ש-Dubiz ידבר בשמו נכון. הכול אופציונלי, ואפשר לשנות בכל רגע.
          שום דבר לא יוצג ללקוחות בלי שסימנת &quot;מאושר לשימוש פומבי&quot;.
        </p>
        <BusinessIdentityEditor />
      </main>
    </div>
  );
}
