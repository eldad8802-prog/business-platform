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
        gridTemplateColumns: "18px 86px minmax(0, 1fr)",
        gap: 10,
        alignItems: "center",
        padding: "11px 0",
        borderBottom: "1px solid #edf1f8",
      }}
    >
      <div style={{ color: "#075bff", fontSize: 18, lineHeight: 1 }}>{icon}</div>
      <div style={{ color: "#6b7899", fontSize: 13, fontWeight: 850 }}>{label}</div>
      <div
        style={{
          color: "#0d1b3d",
          fontSize: 14,
          fontWeight: 950,
          textAlign: "left",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}
