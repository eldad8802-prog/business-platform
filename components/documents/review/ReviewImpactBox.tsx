import ReviewTrustChecklistItem from "./ReviewTrustChecklistItem";

export default function ReviewImpactBox({ approvalImpact }: { approvalImpact: string }) {
  return (
    <div
      style={{
        border: "1px solid #e9d5ff",
        background: "#fbf7ff",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div style={{ color: "#6b21a8", fontSize: 13, fontWeight: 950, marginBottom: 10 }}>
        מה יקרה אחרי אישור?
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        <ReviewTrustChecklistItem>יתווסף לדוח החודשי</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>זמין בחיפוש מסמכים</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>ייכלל בחבילה לרו״ח</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>{approvalImpact}</ReviewTrustChecklistItem>
      </div>
    </div>
  );
}
