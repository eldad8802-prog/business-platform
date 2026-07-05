import type { TrustLevel } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/documents-theme";

export default function ReviewReliabilityScale({ level }: { level: TrustLevel }) {
  const steps = [
    {
      key: "high",
      label: "גבוהה",
      color: TOKEN.semantic.success.ink,
      bg: TOKEN.semantic.success.bgSoft,
      text: "מוכן לאישור",
    },
    {
      key: "medium",
      label: "בינונית",
      color: TOKEN.semantic.attention.ink,
      bg: TOKEN.semantic.attention.bgSoft,
      text: "בדיקה קצרה",
    },
    {
      key: "ambiguous",
      label: "לא מזוהה בוודאות",
      color: TOKEN.semantic.attention.ink,
      bg: TOKEN.semantic.attention.bgSoft,
      text: "נדרשת בחירה",
    },
    {
      key: "low",
      label: "נמוכה",
      color: TOKEN.semantic.urgent.ink,
      bg: TOKEN.semantic.urgent.bgSoft,
      text: "צריך תיקון",
    },
  ] as const;

  const active = steps.find((step) => step.key === level) ?? steps[1];

  return (
    <div style={boxStyle}>
      <div style={headStyle}>
        <div style={titleStyle}>רמת ביטחון</div>
        <div style={{ ...pillStyle, background: active.bg, color: active.color }}>
          {active.label}
        </div>
      </div>
      <div style={gridStyle}>
        {steps.map((step) => {
          const isActive = step.key === level;
          return (
            <div
              key={step.key}
              style={{
                ...stepStyle,
                background: isActive ? step.bg : TOKEN.surface.inset,
                border: isActive
                  ? `1px solid ${step.color}`
                  : `1px solid ${TOKEN.border.DEFAULT}`,
              }}
            >
              <div
                style={{
                  ...dotStyle,
                  background: step.color,
                  opacity: isActive ? 1 : 0.42,
                }}
              />
              <div
                style={{
                  ...stepTextStyle,
                  color: isActive ? step.color : TOKEN.ink.muted,
                }}
              >
                {step.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const boxStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
} as const;

const headStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 12,
} as const;

const titleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const pillStyle = {
  borderRadius: TOKEN.radius.pill,
  padding: "6px 11px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 7,
} as const;

const stepStyle = {
  borderRadius: TOKEN.radius.button,
  padding: "10px 6px",
  textAlign: "center",
} as const;

const dotStyle = {
  width: 10,
  height: 10,
  borderRadius: TOKEN.radius.pill,
  margin: "0 auto 6px",
} as const;

const stepTextStyle = {
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.3,
} as const;
