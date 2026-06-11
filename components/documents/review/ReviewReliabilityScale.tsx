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
      label: "לא חד משמעית",
      color: "#f0782b",
      bg: "#fff1e7",
      text: "צריך החלטה",
    },
    {
      key: "medium",
      label: "בינונית",
      color: "#f59e0b",
      bg: "#fffbeb",
      text: "בדיקה קצרה",
    },
    {
      key: "high",
      label: "גבוהה",
      color: "#16945a",
      bg: "#e9f9ef",
      text: "מוכן לאישור",
    },
  ] as const;

  const active = steps.find((step) => step.key === level) ?? steps[1];

  return (
    <div
      style={{
        border: "1px solid #e1e8f4",
        background: "#ffffff",
        borderRadius: 18,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ color: "#0d1b3d", fontSize: 14, fontWeight: 950 }}>
          רמת ביטחון
        </div>
        <div
          style={{
            borderRadius: 999,
            background: active.bg,
            color: active.color,
            padding: "6px 11px",
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
          gap: 7,
        }}
      >
        {steps.map((step) => {
          const isActive = step.key === level;
          return (
            <div
              key={step.key}
              style={{
                borderRadius: 12,
                padding: "10px 6px",
                background: isActive ? step.bg : "#f8fbff",
                border: isActive ? `1px solid ${step.color}` : "1px solid #edf1f8",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: step.color,
                  margin: "0 auto 6px",
                  opacity: isActive ? 1 : 0.42,
                }}
              />
              <div
                style={{
                  color: isActive ? step.color : "#6b7899",
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
