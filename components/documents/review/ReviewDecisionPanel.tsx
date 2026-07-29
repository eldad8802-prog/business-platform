"use client";

import type { CSSProperties } from "react";
import type { TrustLevel } from "@/lib/documents/review/types";
import type { PreviewView } from "@/lib/documents/review/preview-visibility";
import type { ReviewFieldListProps } from "./ReviewFieldList";
import ReviewActions from "./ReviewActions";
import type { ReviewActionsProps } from "./ReviewActions";
import ReviewFieldList from "./ReviewFieldList";
import ReviewImpactBox from "./ReviewImpactBox";
import ReviewDocumentPreviewPanel from "./ReviewDocumentPreviewPanel";
import ReviewTrustSummary from "./ReviewTrustSummary";
import ReviewWorkspaceLayout from "./ReviewWorkspaceLayout";
import { orangePill } from "./review-ui";
import { TOKEN } from "@/lib/design/documents-theme";
import styles from "./review-adaptive.module.css";

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

// DS v1 tokens handed to review-adaptive.module.css as custom properties, so the
// stylesheet carries structure only (no palette). Custom-property keys need the
// CSSProperties cast.
const cardVars = {
  "--rvw-card": TOKEN.surface.card,
  "--rvw-inset": TOKEN.surface.inset,
  "--rvw-line": TOKEN.border.DEFAULT,
  "--rvw-shadow": TOKEN.shadow.elevated,
  "--rvw-radius-card": `${TOKEN.radius.card}px`,
  "--rvw-radius-input": `${TOKEN.radius.input}px`,
  "--rvw-pad-xl": `${TOKEN.space.xl}px`,
} as CSSProperties;

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
    <section className={styles.decisionCard} style={cardVars}>
      <ReviewWorkspaceLayout
        editorTop={
          <>
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
            <ReviewImpactBox approvalImpact={approvalImpact} />
          </>
        }
        preview={
          <ReviewDocumentPreviewPanel
            previewView={previewView}
            fileBlobUrl={fileBlobUrl}
            onPreviewFailed={onPreviewFailed}
            vendorDisplay={vendorDisplay}
            amountDisplay={amountDisplay}
            dateDisplay={dateDisplay}
            categoryDisplay={categoryDisplay}
            directionDisplay={directionDisplay}
          />
        }
        editorBottom={
          <>
            <ReviewTrustSummary
              trustLevel={trustLevel}
              trustTitle={trustTitle}
              trustSummary={trustSummary}
              trustReasons={trustReasons}
            />
            <ReviewFieldList {...fieldList} />
          </>
        }
        actions={<ReviewActions {...actions} />}
      />
    </section>
  );
}
