import ReviewTrustChecklistItem from "./ReviewTrustChecklistItem";

export default function ReviewImpactBox({ approvalImpact }: { approvalImpact: string }) {
  return (
    <div
      style={{
        border: "1px solid #d8e2f2",
        background: "#f8fbff",
        borderRadius: 20,
        padding: 16,
      }}
    >
      <div style={{ color: "#0d1b3d", fontSize: 16, fontWeight: 950, marginBottom: 10 }}>
        אחרי האישור
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ReviewTrustChecklistItem>הרשומה תישמר ב-Documents</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>אפשר יהיה לאתר אותה בחיפוש</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>היא תיכלל בחומר לרו״ח כשזה רלוונטי</ReviewTrustChecklistItem>
        <ReviewTrustChecklistItem>{approvalImpact}</ReviewTrustChecklistItem>
      </div>
    </div>
  );
}
