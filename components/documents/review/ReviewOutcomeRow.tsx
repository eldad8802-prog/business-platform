export default function ReviewOutcomeRow({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "34px 1fr",
        gap: 10,
        padding: "14px 12px",
        borderBottom: "1px solid #edf1f8",
      }}
    >
      <div style={{ color: "#ff8a2a", fontSize: 22, fontWeight: 950 }}>{icon}</div>
      <div>
        <div style={{ color: "#0d1b3d", fontSize: 14, fontWeight: 950 }}>{title}</div>
        <div style={{ color: "#6b7899", fontSize: 13, fontWeight: 750, marginTop: 4 }}>
          {body}
        </div>
      </div>
    </div>
  );
}
