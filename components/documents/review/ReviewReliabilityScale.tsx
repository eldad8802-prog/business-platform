import type { TrustLevel } from "@/lib/documents/review/types";

export default function ReviewReliabilityScale({ level }: { level: TrustLevel }) {
  const steps = [
    {
      key: "low",
      label: "נמוכה",
      color: "#ef4444",
      bg: "#fef2f2",
      text: "צריך תיקון",
    },
    {
      key: "ambiguous",
      label: "לא חד-משמעית",
      color: "#f97316",
      bg: "#fff7ed",
      text: "צריך החלטה",
    },
    {
      key: "medium",
      label: "בינונית",
      color: "#eab308",
      bg: "#fefce8",
      text: "בדיקה קצרה",
    },
    {
      key: "high",
      label: "גבוהה",
      color: "#22c55e",
      bg: "#f0fdf4",
      text: "מוכן לאישור",
    },
  ] as const;

  const active = steps.find((step) => step.key === level) ?? steps[1];

  return (
    <div
      style={{
        border: "1px solid #dfe7f3",
        background: "#ffffff",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950 }}>
          מדרג אמינות המערכת
        </div>
        <div
          style={{
            borderRadius: 999,
            background: active.bg,
            color: active.color,
            padding: "5px 10px",
            fontSize: 12,
            fontWeight: 950,
          }}
        >
          {active.label}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 6,
        }}
      >
        {steps.map((step) => {
          const isActive = step.key === level;
          return (
            <div
              key={step.key}
              style={{
                borderRadius: 10,
                padding: "9px 6px",
                background: isActive ? step.bg : "#f8fafc",
                border: isActive ? `1px solid ${step.color}` : "1px solid #e5e7eb",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: step.color,
                  margin: "0 auto 5px",
                  opacity: isActive ? 1 : 0.45,
                }}
              />
              <div
                style={{
                  color: isActive ? step.color : "#64748b",
                  fontSize: 11,
                  fontWeight: 950,
                  lineHeight: 1.3,
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
