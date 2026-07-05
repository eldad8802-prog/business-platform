import { TOKEN } from "@/lib/design/documents-theme";

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
        borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
      }}
    >
      <div style={{ color: TOKEN.semantic.attention.ink, fontSize: 22, fontWeight: 950 }}>{icon}</div>
      <div>
        <div style={{ color: TOKEN.ink.primary, fontSize: 14, fontWeight: 950 }}>{title}</div>
        <div style={{ color: TOKEN.ink.muted, fontSize: 13, fontWeight: 750, marginTop: 4 }}>
          {body}
        </div>
      </div>
    </div>
  );
}
