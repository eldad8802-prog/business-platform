import { editPillBtn } from "@/app/(shell)/documents/ui";
import { TOKEN } from "@/lib/design/documents-theme";
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
  const primaryLabel = "עדכן";

  return (
    <div
      style={{
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: TOKEN.radius.card,
        padding: "14px 16px",
        background: TOKEN.surface.card,
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
              marginBottom: 7,
            }}
          >
            <span
              style={{
                fontSize: TOKEN.font.meta,
                color: TOKEN.ink.muted,
                fontWeight: TOKEN.weight.bold,
              }}
            >
              {label}
            </span>
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
            <span style={{ fontSize: 12, fontWeight: 600, color: cfg.captionColor }}>
              {cfg.caption}
            </span>
          </div>
          <div
            style={{
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              color: missing ? TOKEN.ink.meta : TOKEN.ink.primary,
              overflowWrap: "anywhere",
              lineHeight: 1.35,
            }}
          >
            {missing ? "לא זוהה" : displayValue}
          </div>
        </div>
        <button
          type="button"
          style={{
            ...editPillBtn,
            border: `1px solid ${TOKEN.brand.softBorder}`,
            background: TOKEN.brand.soft,
            color: TOKEN.brand.mid,
            borderRadius: TOKEN.radius.pill,
          }}
          onClick={onPrimary}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
