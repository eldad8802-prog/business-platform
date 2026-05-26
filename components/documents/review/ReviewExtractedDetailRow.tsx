export default function ReviewExtractedDetailRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid #eef2f7",
      }}
    >
      <div style={{ color: "#002b6b", fontSize: 17 }}>{icon}</div>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 850 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950, textAlign: "left" }}>
        {value}
      </div>
    </div>
  );
}
