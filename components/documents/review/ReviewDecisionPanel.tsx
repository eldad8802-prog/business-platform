"use client";

import type { TrustLevel } from "@/lib/documents/review/types";
import type { ReviewFieldListProps } from "./ReviewFieldList";
import ReviewActions from "./ReviewActions";
import type { ReviewActionsProps } from "./ReviewActions";
import ReviewAiExtractedCard from "./ReviewAiExtractedCard";
import ReviewFieldList from "./ReviewFieldList";
import ReviewImpactBox from "./ReviewImpactBox";
import ReviewPreviewFallback from "./ReviewPreviewFallback";
import ReviewTrustSummary from "./ReviewTrustSummary";
import { orangePill, reviewCard, reviewSoftPanel } from "./review-ui";

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
    <section style={reviewCard}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          style={{
            border: "none",
            background: "transparent",
            color: "#075bff",
            fontSize: 15,
            fontWeight: 900,
            cursor: "pointer",
          }}
          onClick={onBack}
        >
          חזרה למסמכים
        </button>
        <div style={{ color: "#0d1b3d", fontSize: 18, fontWeight: 950 }}>
          {reviewMode === "financial" ? "מסמך פיננסי" : "מסמך מידע"}
        </div>
        <div
          style={{
            ...orangePill,
            background: trustLevel === "high" ? "#e9f9ef" : "#fff1e7",
            color: trustLevel === "high" ? "#16945a" : "#f0782b",
          }}
        >
          {trustLevel === "high" ? "בטוח לאישור" : "דורש בדיקה"}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 22,
          alignItems: "start",
        }}
      >
        <div style={reviewSoftPanel}>
          <div
            style={{
              minHeight: 330,
              background: "#ffffff",
              border: "1px solid #e1e8f4",
              borderRadius: 18,
              padding: 18,
              boxShadow: "0 14px 30px rgba(13, 27, 61, 0.08)",
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
                  height: 330,
                  border: "none",
                  borderRadius: 14,
                  background: "#ffffff",
                }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- Secure object URL preview, not a static/image-optimization asset.
              <img
                src={fileBlobUrl as string}
                alt="תצוגת מסמך"
                onError={onPreviewFailed}
                style={{
                  width: "100%",
                  maxHeight: 330,
                  objectFit: "contain",
                  borderRadius: 14,
                }}
              />
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
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
