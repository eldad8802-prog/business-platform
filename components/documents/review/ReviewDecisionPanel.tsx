"use client";

import type { TrustLevel } from "@/lib/documents/review/types";
import type { PreviewView } from "@/lib/documents/review/preview-visibility";
import type { ReviewFieldListProps } from "./ReviewFieldList";
import ReviewActions from "./ReviewActions";
import type { ReviewActionsProps } from "./ReviewActions";
import ReviewAiExtractedCard from "./ReviewAiExtractedCard";
import ReviewFieldList from "./ReviewFieldList";
import ReviewImpactBox from "./ReviewImpactBox";
import ReviewPreviewFallback from "./ReviewPreviewFallback";
import ReviewTrustSummary from "./ReviewTrustSummary";
import { orangePill, reviewCard, reviewSoftPanel } from "./review-ui";
import { TOKEN } from "@/lib/design/documents-theme";

export type ReviewDecisionPanelProps = {
  reviewMode: "financial" | "document";
  trustLevel: TrustLevel;
  onBack: () => void;
  previewView: PreviewView;
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
  previewView,
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
        <div style={{ color: TOKEN.ink.primary, fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold }}>
          {reviewMode === "financial" ? "מסמך פיננסי" : "מסמך מידע"}
        </div>
        <div
          style={{
            ...orangePill,
            background: trustLevel === "high" ? TOKEN.semantic.success.bgSoft : TOKEN.semantic.attention.bgSoft,
            color: trustLevel === "high" ? TOKEN.semantic.success.ink : TOKEN.semantic.attention.ink,
          }}
        >
          {trustLevel === "high" ? "בטוח לאישור" : "דורש בדיקה"}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ ...reviewSoftPanel, order: 2 }}>
          <div
            style={{
              minHeight: 330,
              background: TOKEN.surface.card,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: TOKEN.radius.card,
              padding: 18,
              boxShadow: TOKEN.shadow.elevated,
            }}
          >
            {previewView === "pdf" ? (
              <iframe
                src={fileBlobUrl as string}
                title="תצוגת מסמך"
                onError={onPreviewFailed}
                style={{
                  width: "100%",
                  height: 330,
                  border: "none",
                  borderRadius: TOKEN.radius.input,
                  background: TOKEN.surface.card,
                }}
              />
            ) : previewView === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- Secure object URL preview, not a static/image-optimization asset.
              <img
                src={fileBlobUrl as string}
                alt="תצוגת מסמך"
                onError={onPreviewFailed}
                style={{
                  width: "100%",
                  maxHeight: 330,
                  objectFit: "contain",
                  borderRadius: TOKEN.radius.input,
                }}
              />
            ) : previewView === "loading" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 294,
                  gap: 8,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 30 }} aria-hidden>
                  ⏳
                </div>
                <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>
                  טוען תצוגת מסמך…
                </div>
                <div style={{ fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>
                  מורידים את קובץ המקור בצורה מאובטחת.
                </div>
              </div>
            ) : (
              <ReviewPreviewFallback
                vendorDisplay={vendorDisplay}
                amountDisplay={amountDisplay}
                dateDisplay={dateDisplay}
                categoryDisplay={categoryDisplay}
                directionDisplay={directionDisplay}
              />
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, order: 1 }}>
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
