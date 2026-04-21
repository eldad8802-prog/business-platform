type Props = {
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
};

export default function RedeemInput({
  value,
  onChange,
  onSubmit,
}: Props) {
  return (
    <div
      style={{
        background: "#ffffff",
        padding: 20,
        borderRadius: 20,
        border: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          marginBottom: 12,
        }}
      >
        מימוש קופון
      </div>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="הכנס קוד קופון"
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "1px solid #d1d5db",
          marginBottom: 12,
          outline: "none",
          fontSize: 16,
          boxSizing: "border-box",
        }}
      />

      <button
        type="button"
        onClick={onSubmit}
        style={{
          width: "100%",
          padding: "14px",
          borderRadius: 12,
          border: "none",
          background: "#111827",
          color: "#ffffff",
          fontWeight: 700,
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        בדוק קופון
      </button>
    </div>
  );
}