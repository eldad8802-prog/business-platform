"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";

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
  const { t } = useI18n();
  const situations = [
    { key: "IDLE_TIME", label: t("billing.couponIssue.situationIdleTime") },
    { key: "LOW_TRAFFIC", label: t("billing.couponIssue.situationLowTraffic") },
    { key: "STUCK_INVENTORY", label: t("billing.couponIssue.situationStuckInventory") },
    { key: "WEAK_SEASON", label: t("billing.couponIssue.situationWeakSeason") },
  ];

  const goals = [
    { key: "BRING_NEW_CUSTOMERS", label: t("billing.couponIssue.goalNewCustomers") },
    { key: "FILL_TIME", label: t("billing.couponIssue.goalFillTime") },
    { key: "SELL_INVENTORY", label: t("billing.couponIssue.goalSellInventory") },
    { key: "RETURN_CUSTOMERS", label: t("billing.couponIssue.goalReturnCustomers") },
  ];

  return (
    <div style={styles.card}>
      <div style={styles.title}>{t("billing.couponIssue.contextTitle")}</div>

      <div style={styles.section}>
        <div style={styles.label}>{t("billing.couponIssue.situationQuestion")}</div>

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
        <div style={styles.label}>{t("billing.couponIssue.goalQuestion")}</div>

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
        {t("billing.couponIssue.continue")}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--dz-surface)",
    border: "1px solid var(--dz-border)",
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
    border: "1px solid var(--dz-border-strong)",
    background: "var(--dz-surface)",
    cursor: "pointer",
    fontWeight: 700,
  },
  optionActive: {
    background: "var(--dz-text-primary)",
    color: "var(--dz-text-on-brand)",
    border: "none",
  },
  continueBtn: {
    width: "100%",
    padding: "14px",
    borderRadius: 14,
    border: "none",
    background: TOKEN.action.primary.background,
    color: "var(--dz-text-on-brand)",
    fontWeight: 800,
    cursor: "pointer",
  },
};