export default function RedeemLoading() {
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
          fontSize: 18,
          fontWeight: 700,
          marginBottom: 8,
          color: "var(--dz-text-primary)",
        }}
      >
        בודק קופון...
      </div>

      <div
        style={{
          fontSize: 14,
          color: "var(--dz-text-muted)",
        }}
      >
        אנא המתן רגע
      </div>
    </div>
  );
}