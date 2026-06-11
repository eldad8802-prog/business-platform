import ReviewExtractedDetailRow from "./ReviewExtractedDetailRow";

export default function ReviewPreviewFallback({
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
    <>
      <div style={{ textAlign: "center", fontSize: 24, fontWeight: 950, color: "#0d1b3d" }}>
        {vendorDisplay}
      </div>
      <div
        style={{
          textAlign: "center",
          color: "#6b7899",
          fontSize: 13,
          fontWeight: 800,
          marginTop: 8,
        }}
      >
        מקור המסמך
      </div>
      <div style={{ marginTop: 24, display: "grid", gap: 10 }}>
        <ReviewExtractedDetailRow icon="•" label="סכום" value={amountDisplay} />
        <ReviewExtractedDetailRow icon="•" label="תאריך" value={dateDisplay} />
        <ReviewExtractedDetailRow icon="•" label="קטגוריה" value={categoryDisplay} />
        <ReviewExtractedDetailRow icon="•" label="כיוון" value={directionDisplay} />
      </div>
    </>
  );
}
