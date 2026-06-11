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
        border: "1px solid #e1e8f4",
        background: "#ffffff",
        borderRadius: 20,
        padding: 16,
        boxShadow: "0 10px 24px rgba(13, 27, 61, 0.05)",
      }}
    >
      <div style={{ color: "#0d1b3d", fontSize: 16, fontWeight: 950, marginBottom: 10 }}>
        פרטים שזוהו
      </div>
      <ReviewExtractedDetailRow icon="•" label="ספק" value={vendorDisplay} />
      <ReviewExtractedDetailRow icon="•" label="סכום" value={amountDisplay} />
      <ReviewExtractedDetailRow icon="•" label="תאריך" value={dateDisplay} />
      <ReviewExtractedDetailRow icon="•" label="קטגוריה" value={categoryDisplay} />
      <ReviewExtractedDetailRow icon="•" label="כיוון" value={directionDisplay} />
    </div>
  );
}
