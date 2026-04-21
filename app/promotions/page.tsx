"use client";

import { useRouter } from "next/navigation";

export default function PromotionsPage() {
  const router = useRouter();

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <div style={styles.headerBlock}>
          <div style={styles.eyebrow}>Promotions</div>

          <h1 style={styles.title}>מבצעים</h1>

          <p style={styles.description}>
            כאן מנהלים את שכבות פיצ&apos;ר המבצעים. כרגע שכבת הקופונים היא השכבה
            הראשונה הפעילה, ובהמשך תתווסף גם שכבת יצירת מבצעים.
          </p>
        </div>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>שכבות בפיצ&apos;ר</div>

          <div style={styles.grid}>
            <button
              type="button"
              onClick={() => router.push("/promotions/coupons")}
              style={{ ...styles.card, ...styles.cardClickable }}
            >
              <div style={styles.cardTopRow}>
                <span style={styles.cardTitle}>קופונים</span>
                <span style={styles.liveBadge}>פעיל</span>
              </div>

              <p style={styles.cardText}>
                שכבה פעילה ליצירת הצעה, הנפקת קופון ומימוש בפועל לפי זרימה מסודרת.
              </p>

              <div style={styles.cardFooter}>כניסה לשכבת הקופונים</div>
            </button>

            <div style={{ ...styles.card, ...styles.cardStatic }}>
              <div style={styles.cardTopRow}>
                <span style={styles.cardTitle}>מבצעים</span>
                <span style={styles.comingSoonBadge}>בקרוב</span>
              </div>

              <p style={styles.cardText}>
                שכבה עתידית ליצירת מבצעים שיווקיים, הנחות רחבות והצעות מכירה כלליות
                ללקוחות.
              </p>

              <div style={styles.cardFooter}>שכבה עתידית בפיתוח</div>
            </div>
          </div>
        </section>

        <section style={styles.infoCard}>
          <div style={styles.infoTitle}>איך זה בנוי עכשיו</div>

          <div style={styles.infoText}>
            פיצ&apos;ר המבצעים הוא המעטפת. כרגע שכבת הקופונים היא השכבה הראשונה
            הפעילה בתוכו, ולכן הזרימה הקיימת של הצעה → קופון → מימוש נשארת כמו
            שהיא, אבל מוצגת כחלק מתוך פיצ&apos;ר מבצעים רחב יותר.
          </div>
        </section>

        <div style={styles.actionsRow}>
          <button
            type="button"
            onClick={() => router.push("/")}
            style={styles.secondaryButton}
          >
            חזרה לדף הראשי
          </button>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "linear-gradient(180deg, #f8fafc 0%, #f4f7f5 45%, #eef4ef 100%)",
    padding: "24px 16px 40px",
    direction: "rtl",
  },
  container: {
    width: "100%",
    maxWidth: 980,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  headerBlock: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 24,
    padding: 24,
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: 800,
    color: "#5f6b66",
    marginBottom: 10,
  },
  title: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.15,
    color: "#111827",
  },
  description: {
    marginTop: 12,
    marginBottom: 0,
    fontSize: 16,
    lineHeight: 1.7,
    color: "#4b5563",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 15,
    fontWeight: 800,
    color: "#1f2937",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 12,
  },
  card: {
    width: "100%",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 18,
    background: "#ffffff",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    textAlign: "right",
  },
  cardClickable: {
    cursor: "pointer",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  cardStatic: {
    cursor: "default",
    opacity: 0.96,
  },
  cardTopRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 800,
    color: "#111827",
  },
  liveBadge: {
    fontSize: 12,
    fontWeight: 800,
    color: "#14532d",
    background: "#dcfce7",
    borderRadius: 999,
    padding: "6px 10px",
    whiteSpace: "nowrap",
  },
  comingSoonBadge: {
    fontSize: 12,
    fontWeight: 800,
    color: "#92400e",
    background: "#fef3c7",
    borderRadius: 999,
    padding: "6px 10px",
    whiteSpace: "nowrap",
  },
  cardText: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.7,
    color: "#4b5563",
  },
  cardFooter: {
    marginTop: "auto",
    fontSize: 13,
    fontWeight: 700,
    color: "#111827",
  },
  infoCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 18,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#111827",
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    lineHeight: 1.7,
    color: "#4b5563",
  },
  actionsRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  secondaryButton: {
    border: "1px solid #d1d5db",
    borderRadius: 16,
    padding: "14px 18px",
    background: "#ffffff",
    color: "#111827",
    fontSize: 15,
    fontWeight: 800,
    cursor: "pointer",
  },
};