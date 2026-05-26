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
        padding: "12px 10px",
        borderBottom: "1px solid #d7f3e3",
      }}
    >
      <div style={{ color: "#22c55e", fontSize: 22 }}>{icon}</div>
      <div>
        <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950 }}>{title}</div>
        <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800, marginTop: 3 }}>
          {body}
        </div>
      </div>
    </div>
  );
}
