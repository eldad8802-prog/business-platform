"use client";

import { card } from "@/app/(shell)/documents/ui";
import type { TrustLevel } from "@/lib/documents/review/types";
import type { ReviewFieldListProps } from "./ReviewFieldList";
import ReviewAiExtractedCard from "./ReviewAiExtractedCard";
import ReviewImpactBox from "./ReviewImpactBox";
import ReviewPreviewFallback from "./ReviewPreviewFallback";
import ReviewTrustSummary from "./ReviewTrustSummary";
import ReviewFieldList from "./ReviewFieldList";
import ReviewActions from "./ReviewActions";
import type { ReviewActionsProps } from "./ReviewActions";

export type ReviewDecisionPanelProps = {
  reviewMode: "financial" | "document";
  trustLevel: TrustLevel;
  onBack: () => void;
  showPreviewFallback: boolean;
  previewKind: "pdf" | "image" | "unsupported";
  fileBlobUrl: string | null;
  onPreviewFailed: () => void;
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
  approvalImpact: string;
  trustTitle: string;
  trustSummary: string;
  trustReasons: string[];
  fieldList: ReviewFieldListProps;
  actions: ReviewActionsProps;
};

export default function ReviewDecisionPanel({
  reviewMode,
  trustLevel,
  onBack,
  showPreviewFallback,
  previewKind,
  fileBlobUrl,
  onPreviewFailed,
  vendorDisplay,
  amountDisplay,
  dateDisplay,
  categoryDisplay,
  directionDisplay,
  approvalImpact,
  trustTitle,
  trustSummary,
  trustReasons,
  fieldList,
  actions,
}: ReviewDecisionPanelProps) {
  return (
    <section style={{ ...card, borderRadius: 18, borderColor: "#dfe7f3" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <button
          type="button"
          style={{
            border: "none",
            background: "transparent",
            color: "#002b6b",
            fontSize: 13,
            fontWeight: 900,
            cursor: "pointer",
          }}
          onClick={onBack}
        >
          חזרה →
        </button>
        <div style={{ color: "#0f172a", fontSize: 15, fontWeight: 950 }}>
          {reviewMode === "financial" ? "הוצאה עסקית" : "מסמך מידע"}
        </div>
        <div
          style={{
            borderRadius: 999,
            background: trustLevel === "high" ? "#dcfce7" : "#fef3c7",
            color: trustLevel === "high" ? "#166534" : "#92400e",
            padding: "6px 10px",
            fontSize: 11,
            fontWeight: 950,
          }}
        >
          {trustLevel === "high" ? "המערכת בטוחה" : "דורש בדיקה"}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 1fr) minmax(260px, 1fr)",
          gap: 16,
        }}
      >
        <div
          style={{
            border: "1px solid #dfe7f3",
            background: "#f8fbff",
            borderRadius: 14,
            padding: 14,
          }}
        >
          <div
            style={{
              minHeight: 300,
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              padding: 18,
              boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)",
            }}
          >
            {showPreviewFallback ? (
              <ReviewPreviewFallback
                vendorDisplay={vendorDisplay}
                amountDisplay={amountDisplay}
                dateDisplay={dateDisplay}
                categoryDisplay={categoryDisplay}
                directionDisplay={directionDisplay}
              />
            ) : previewKind === "pdf" ? (
              <iframe
                src={fileBlobUrl as string}
                title="תצוגת מסמך"
                onError={onPreviewFailed}
                style={{
                  width: "100%",
                  height: 300,
                  border: "none",
                  borderRadius: 8,
                  background: "#ffffff",
                }}
              />
            ) : (
              <img
                src={fileBlobUrl as string}
                alt="תצוגת מסמך"
                onError={onPreviewFailed}
                style={{
                  width: "100%",
                  maxHeight: 300,
                  objectFit: "contain",
                  borderRadius: 8,
                }}
              />
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <ReviewAiExtractedCard
            vendorDisplay={vendorDisplay}
            amountDisplay={amountDisplay}
            dateDisplay={dateDisplay}
            categoryDisplay={categoryDisplay}
            directionDisplay={directionDisplay}
          />
          <ReviewImpactBox approvalImpact={approvalImpact} />
        </div>
      </div>

      <ReviewTrustSummary
        trustLevel={trustLevel}
        trustTitle={trustTitle}
        trustSummary={trustSummary}
        trustReasons={trustReasons}
      />

      <ReviewFieldList {...fieldList} />
      <ReviewActions {...actions} />
    </section>
  );
}
