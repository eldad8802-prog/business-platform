import type { TrustLevel } from "@/lib/documents/review/types";
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
  return (
    <>
      <div
        style={{
          border: "1px solid #dfe7f3",
          background: "#ffffff",
          borderRadius: 14,
          padding: 14,
          marginTop: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span
            style={{
              borderRadius: 999,
              background: trustLevel === "high" ? "#dcfce7" : "#fef3c7",
              color: trustLevel === "high" ? "#166534" : "#92400e",
              padding: "5px 9px",
              fontSize: 12,
              fontWeight: 950,
            }}
          >
            {trustTitle}
          </span>
        </div>
        <p
          style={{
            margin: 0,
            color: trustLevel === "high" ? "#166534" : "#92400e",
            fontSize: 13,
            fontWeight: 850,
            lineHeight: 1.55,
          }}
        >
          {trustSummary}
        </p>
        {trustReasons.length > 1 ? (
          <div style={{ marginTop: 8, display: "grid", gap: 5 }}>
            {trustReasons.slice(1, 4).map((reason) => (
              <ReviewTrustChecklistItem key={reason}>{reason}</ReviewTrustChecklistItem>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 12 }}>
        <ReviewReliabilityScale level={trustLevel} />
      </div>
    </>
  );
}
