import { TOKEN } from "@/lib/design/tokens";

export default function ReviewPreviewFallback({
  vendorDisplay,
}: {
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
}) {
  return (
    <>
      <div style={{ textAlign: "center", fontSize: 24, fontWeight: 950, color: TOKEN.ink.primary }}>
        {vendorDisplay}
      </div>
      <div
        style={{
          textAlign: "center",
          color: TOKEN.ink.muted,
          fontSize: 13,
          fontWeight: 800,
          marginTop: 8,
        }}
      >
        מקור המסמך
      </div>
      <div
        style={{
          marginTop: 24,
          border: `1px dashed ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.card,
          background: TOKEN.surface.inset,
          padding: 18,
          color: TOKEN.ink.muted,
          fontSize: 14,
          fontWeight: 800,
          lineHeight: 1.6,
        }}
      >
        התצוגה המקורית אינה זמינה כרגע, אבל הפרטים שזוהו מוצגים למעלה לעריכה ואישור.
      </div>
    </>
  );
}
