import ReviewExtractedDetailRow from "./ReviewExtractedDetailRow";

export default function ReviewAiExtractedCard({
  vendorDisplay,
  amountDisplay,
  dateDisplay,
  categoryDisplay,
  directionDisplay,
}: {
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #bbf7d0",
        background: "#f0fdf4",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div style={{ color: "#166534", fontSize: 12, fontWeight: 950, marginBottom: 8 }}>
        המערכת זיהתה
      </div>
      <ReviewExtractedDetailRow icon="⌂" label="ספק" value={vendorDisplay} />
      <ReviewExtractedDetailRow icon="₪" label="סכום" value={amountDisplay} />
      <ReviewExtractedDetailRow icon="◷" label="תאריך" value={dateDisplay} />
      <ReviewExtractedDetailRow icon="▣" label="קטגוריה" value={categoryDisplay} />
      <ReviewExtractedDetailRow icon="→" label="כיוון" value={directionDisplay} />
    </div>
  );
}
