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
  const highTrust = trustLevel === "high";

  return (
    <>
      <div
        style={{
          border: "1px solid #e1e8f4",
          background: "#ffffff",
          borderRadius: 18,
          padding: 16,
          marginTop: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span
            style={{
              borderRadius: 999,
              background: highTrust ? "#e9f9ef" : "#fff1e7",
              color: highTrust ? "#16945a" : "#f0782b",
              padding: "6px 11px",
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
            color: highTrust ? "#16945a" : "#9a4a11",
            fontSize: 14,
            fontWeight: 800,
            lineHeight: 1.6,
          }}
        >
          {trustSummary}
        </p>
        {trustReasons.length > 1 ? (
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
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
