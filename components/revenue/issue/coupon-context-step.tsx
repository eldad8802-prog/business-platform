"use client";

type Props = {
  situation: string | null;
  goal: string | null;
  onChangeSituation: (val: string) => void;
  onChangeGoal: (val: string) => void;
  onContinue: () => void;
};

export default function CouponContextStep({
  situation,
  goal,
  onChangeSituation,
  onChangeGoal,
  onContinue,
}: Props) {
  const situations = [
    { key: "IDLE_TIME", label: "שעות מתות" },
    { key: "LOW_TRAFFIC", label: "תנועה נמוכה" },
    { key: "STUCK_INVENTORY", label: "מלאי תקוע" },
    { key: "WEAK_SEASON", label: "עונה חלשה" },
  ];

  const goals = [
    { key: "BRING_NEW_CUSTOMERS", label: "להביא לקוחות חדשים" },
    { key: "FILL_TIME", label: "למלא זמן פנוי" },
    { key: "SELL_INVENTORY", label: "למכור מלאי" },
    { key: "RETURN_CUSTOMERS", label: "להחזיר לקוחות" },
  ];

  return (
    <div style={styles.card}>
      <div style={styles.title}>לפני יצירת קופון</div>

      <div style={styles.section}>
        <div style={styles.label}>מה המצב שלך עכשיו?</div>

        <div style={styles.options}>
          {situations.map((s) => (
            <button
              key={s.key}
              onClick={() => onChangeSituation(s.key)}
              style={{
                ...styles.option,
                ...(situation === s.key ? styles.optionActive : {}),
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.label}>מה המטרה שלך?</div>

        <div style={styles.options}>
          {goals.map((g) => (
            <button
              key={g.key}
              onClick={() => onChangeGoal(g.key)}
              style={{
                ...styles.option,
                ...(goal === g.key ? styles.optionActive : {}),
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <button
        disabled={!situation || !goal}
        onClick={onContinue}
        style={{
          ...styles.continueBtn,
          opacity: situation && goal ? 1 : 0.5,
        }}
      >
        המשך
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 800,
    marginBottom: 16,
  },
  section: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 10,
  },
  options: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  option: {
    padding: "12px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    cursor: "pointer",
    fontWeight: 700,
  },
  optionActive: {
    background: "#111827",
    color: "#ffffff",
    border: "none",
  },
  continueBtn: {
    width: "100%",
    padding: "14px",
    borderRadius: 14,
    border: "none",
    background: "#111827",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
  },
};