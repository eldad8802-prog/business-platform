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
      <div style={{ textAlign: "center", fontSize: 22, fontWeight: 950 }}>{vendorDisplay}</div>
      <div
        style={{
          textAlign: "center",
          color: "#64748b",
          fontSize: 12,
          fontWeight: 800,
          marginTop: 6,
        }}
      >
        מקור המסמך
      </div>
      <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
        <ReviewExtractedDetailRow icon="₪" label="סכום" value={amountDisplay} />
        <ReviewExtractedDetailRow icon="◷" label="תאריך" value={dateDisplay} />
        <ReviewExtractedDetailRow icon="▣" label="קטגוריה" value={categoryDisplay} />
        <ReviewExtractedDetailRow icon="↗" label="כיוון" value={directionDisplay} />
      </div>
    </>
  );
}
