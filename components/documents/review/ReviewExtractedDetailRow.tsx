import { TOKEN } from "@/lib/design/documents-theme";

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
    <div style={rowStyle}>
      <div style={iconStyle}>{icon}</div>
      <div style={labelStyle}>{label}</div>
      <div style={valueStyle}>{value}</div>
    </div>
  );
}

const rowStyle = {
  display: "grid",
  gridTemplateColumns: "18px 86px minmax(0, 1fr)",
  gap: 10,
  alignItems: "center",
  padding: "11px 0",
  borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
} as const;

const iconStyle = {
  color: TOKEN.brand.mid,
  fontSize: 18,
  lineHeight: 1,
} as const;

const labelStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const valueStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  textAlign: "left",
  overflowWrap: "anywhere",
} as const;
