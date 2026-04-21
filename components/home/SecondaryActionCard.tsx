"use client";

type SecondaryActionCardProps = {
  title: string;
  description: string;
  badge?: string;
  onClick?: () => void;
};

export default function SecondaryActionCard({
  title,
  description,
  badge,
  onClick,
}: SecondaryActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.card,
        ...(onClick ? styles.cardClickable : styles.cardStatic),
      }}
    >
      <div style={styles.topRow}>
        <span style={styles.title}>{title}</span>
        {badge ? <span style={styles.badge}>{badge}</span> : null}
      </div>

      <p style={styles.description}>{description}</p>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: "100%",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 16,
    background: "#ffffff",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    textAlign: "right",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  },
  cardClickable: {
    cursor: "pointer",
  },
  cardStatic: {
    cursor: "default",
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: 800,
    color: "#111827",
  },
  badge: {
    fontSize: 12,
    fontWeight: 800,
    color: "#14532d",
    background: "#dcfce7",
    borderRadius: 999,
    padding: "6px 10px",
    whiteSpace: "nowrap",
  },
  description: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.6,
    color: "#4b5563",
  },
};