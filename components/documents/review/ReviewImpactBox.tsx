import ReviewTrustChecklistItem from "./ReviewTrustChecklistItem";
import { TOKEN } from "@/lib/design/tokens";

export default function ReviewImpactBox({ approvalImpact }: { approvalImpact: string }) {
  return (
    <div
      style={{
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        background: TOKEN.surface.inset,
        borderRadius: TOKEN.radius.card,
        padding: 16,
      }}
    >
      <div style={{ color: TOKEN.ink.primary, fontSize: 16, fontWeight: 950, marginBottom: 10 }}>
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
