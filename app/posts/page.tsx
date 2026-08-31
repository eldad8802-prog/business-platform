export default function PostsPage() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.badge}>בקרוב</div>
        <h1 style={styles.title}>יצירת תוכן</h1>
        <p style={styles.text}>
          הפיצ’ר הזה עדיין לא פעיל, אבל הוא כבר שמור במקום הנכון במערכת.
        </p>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, var(--dz-surface-muted) 0%, var(--dz-surface-muted) 100%)",
    direction: "rtl",
    padding: "24px 16px",
    boxSizing: "border-box",
  },
  card: {
    maxWidth: 520,
    margin: "0 auto",
    background: "var(--dz-surface)",
    border: "1px solid var(--dz-border)",
    borderRadius: 24,
    padding: "24px 20px",
    boxShadow: "0 10px 30px rgba(52, 60, 50, 0.06)",
  },
  badge: {
    display: "inline-block",
    marginBottom: 14,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    background: "var(--dz-warning-bg)",
    color: "var(--dz-warning)",
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 800,
    color: "var(--dz-text-primary)",
    lineHeight: 1.2,
  },
  text: {
    margin: "12px 0 0",
    fontSize: 16,
    lineHeight: 1.7,
    color: "var(--dz-text-secondary)",
  },
}