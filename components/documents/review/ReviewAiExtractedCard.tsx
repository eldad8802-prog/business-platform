import ReviewExtractedDetailRow from "./ReviewExtractedDetailRow";
import { TOKEN } from "@/lib/design/tokens";

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
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        background: TOKEN.surface.card,
        borderRadius: TOKEN.radius.card,
        padding: 16,
        boxShadow: TOKEN.shadow.elevated,
      }}
    >
      <div
        style={{
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.bold,
          marginBottom: 10,
        }}
      >
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
