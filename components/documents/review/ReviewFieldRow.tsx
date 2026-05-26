import { editPillBtn } from "@/app/(shell)/documents/ui";
import { TRAFFIC_CONFIG } from "@/lib/documents/review/traffic";
import type { TrafficLevel } from "@/lib/documents/review/types";

export default function ReviewFieldRow({
  label,
  displayValue,
  level,
  missing,
  onPrimary,
}: {
  label: string;
  displayValue: string;
  level: TrafficLevel;
  missing: boolean;
  onPrimary: () => void;
}) {
  const cfg = TRAFFIC_CONFIG[level];
  const primaryLabel = missing ? "הוסף" : "ערוך";
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: "12px 14px",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 800 }}>{label}</span>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: cfg.dot,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 800, color: cfg.captionColor }}>
              {cfg.caption}
            </span>
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 950,
              color: missing ? "#9ca3af" : "#111827",
              overflowWrap: "anywhere",
              lineHeight: 1.35,
            }}
          >
            {missing ? "לא זוהה" : displayValue}
          </div>
        </div>
        <button type="button" style={editPillBtn} onClick={onPrimary}>
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
