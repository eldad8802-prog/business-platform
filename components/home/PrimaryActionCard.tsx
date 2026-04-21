"use client";

type PrimaryActionCardProps = {
  title: string;
  description: string;
  ctaText: string;
  onClick: () => void;
};

export default function PrimaryActionCard({
  title,
  description,
  ctaText,
  onClick,
}: PrimaryActionCardProps) {
  return (
    <button type="button" onClick={onClick} style={styles.card}>
      <div style={styles.content}>
        <div style={styles.iconWrap}>
          <span style={styles.icon}>₪</span>
        </div>

        <div style={styles.textBlock}>
          <h2 style={styles.title}>{title}</h2>
          <p style={styles.description}>{description}</p>
        </div>
      </div>

      <div style={styles.footer}>
        <span style={styles.cta}>{ctaText}</span>
        <span style={styles.arrow}>←</span>
      </div>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: "100%",
    border: "none",
    borderRadius: 24,
    padding: 20,
    background:
      "linear-gradient(135deg, #0f172a 0%, #1f3b2f 55%, #355c47 100%)",
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 18,
    textAlign: "right",
    boxShadow: "0 18px 40px rgba(15, 23, 42, 0.16)",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    background: "rgba(255,255,255,0.14)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    fontSize: 24,
    fontWeight: 800,
  },
  textBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  title: {
    margin: 0,
    fontSize: 26,
    lineHeight: 1.15,
    fontWeight: 800,
  },
  description: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.6,
    color: "rgba(255,255,255,0.88)",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cta: {
    fontSize: 15,
    fontWeight: 800,
  },
  arrow: {
    fontSize: 22,
    fontWeight: 800,
  },
};