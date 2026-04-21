type Props = {
  result: any;
  onReset: () => void;
};

export default function RedeemSuccess({ result, onReset }: Props) {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
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
          background: "#111827",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        מימוש נוסף
      </button>
    </div>
  );
}