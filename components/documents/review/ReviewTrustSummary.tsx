import type { TrustLevel } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/tokens";
import ReviewReliabilityScale from "./ReviewReliabilityScale";
import ReviewTrustChecklistItem from "./ReviewTrustChecklistItem";

export default function ReviewTrustSummary({
  trustLevel,
  trustTitle,
  trustSummary,
  trustReasons,
}: {
  trustLevel: TrustLevel;
  trustTitle: string;
  trustSummary: string;
  trustReasons: string[];
}) {
  const highTrust = trustLevel === "high";
  const semantic = highTrust ? TOKEN.semantic.success : TOKEN.semantic.attention;

  return (
    <>
      <div style={boxStyle}>
        <div style={labelRowStyle}>
          <span
            style={{
              ...pillStyle,
              background: semantic.bgSoft,
              color: semantic.ink,
            }}
          >
            {trustTitle}
          </span>
        </div>
        <p style={{ ...summaryStyle, color: semantic.ink }}>{trustSummary}</p>
        {trustReasons.length > 1 ? (
          <div style={reasonsStyle}>
            {trustReasons.slice(1, 4).map((reason) => (
              <ReviewTrustChecklistItem key={reason}>{reason}</ReviewTrustChecklistItem>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <ReviewReliabilityScale level={trustLevel} />
      </div>
    </>
  );
}

const boxStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  marginTop: 18,
} as const;

const labelRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
} as const;

const pillStyle = {
  borderRadius: TOKEN.radius.pill,
  padding: "6px 11px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const summaryStyle = {
  margin: 0,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.6,
} as const;

const reasonsStyle = {
  marginTop: 10,
  display: "grid",
  gap: 6,
} as const;
