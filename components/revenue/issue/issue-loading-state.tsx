export default function IssueLoadingState() {
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--dz-text-primary)",
          marginBottom: 10,
        }}
      >
        יוצר קופון...
      </div>

      <div
        style={{
          fontSize: 15,
          color: "var(--dz-text-muted)",
        }}
      >
        עוד רגע ה־QR יהיה מוכן
      </div>
    </div>
  );
}