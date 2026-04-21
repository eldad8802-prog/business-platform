type Props = {
  message: string;
  onRetry: () => void;
};

export default function RedeemError({ message, onRetry }: Props) {
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
          fontSize: 18,
          fontWeight: 700,
          marginBottom: 10,
          color: "#dc2626",
        }}
      >
        שגיאה
      </div>

      <div
        style={{
          marginBottom: 16,
          color: "#374151",
          lineHeight: 1.5,
        }}
      >
        {message}
      </div>

      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: "12px 16px",
          borderRadius: 12,
          border: "none",
          background: "#111827",
          color: "#ffffff",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}