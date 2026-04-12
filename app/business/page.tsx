export default function BusinessPage() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.badge}>בקרוב</div>
        <h1 style={styles.title}>העסק שלי</h1>
        <p style={styles.text}>
          כאן יהיה בהמשך המקום לניהול פרטי העסק והגדרות בסיסיות של המערכת.
        </p>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)",
    direction: "rtl",
    padding: "24px 16px",
    boxSizing: "border-box",
  },
  card: {
    maxWidth: 520,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 24,
    padding: "24px 20px",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  },
  badge: {
    display: "inline-block",
    marginBottom: 14,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    background: "#fef3c7",
    color: "#92400e",
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 800,
    color: "#0f172a",
    lineHeight: 1.2,
  },
  text: {
    margin: "12px 0 0",
    fontSize: 16,
    lineHeight: 1.7,
    color: "#475569",
  },
};