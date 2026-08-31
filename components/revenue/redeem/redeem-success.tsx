import { TOKEN } from "@/lib/design/tokens";

type Props = {
  result: any;
  onReset: () => void;
};

export default function RedeemSuccess({ result, onReset }: Props) {
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        padding: 20,
        borderRadius: 20,
        border: "1px solid var(--dz-border)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        הקופון מומש בהצלחה 🎉
      </div>

      <div style={{ marginBottom: 16 }}>
        {result?.coupon?.offer?.title || ""}
      </div>

      <button
        onClick={onReset}
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          background: TOKEN.action.primary.background,
          color: "var(--dz-text-on-brand)",
          cursor: "pointer",
        }}
      >
        מימוש נוסף
      </button>
    </div>
  );
}