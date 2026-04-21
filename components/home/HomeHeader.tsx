"use client";

type HomeHeaderProps = {
  businessName?: string;
  greeting: string;
  onLogout: () => void;
};

export default function HomeHeader({
  businessName,
  greeting,
  onLogout,
}: HomeHeaderProps) {
  return (
    <header style={styles.wrapper}>
      <div style={styles.textBlock}>
        <p style={styles.businessName}>
          {businessName?.trim() ? businessName : "העסק שלך"}
        </p>
        <h1 style={styles.greeting}>{greeting}</h1>
      </div>

      <button type="button" onClick={onLogout} style={styles.logoutButton}>
        התנתק
      </button>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 4,
  },
  textBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
  },
  businessName: {
    margin: 0,
    fontSize: 13,
    fontWeight: 700,
    color: "#5f6b66",
  },
  greeting: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.15,
    fontWeight: 800,
    color: "#111827",
  },
  logoutButton: {
    flexShrink: 0,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};