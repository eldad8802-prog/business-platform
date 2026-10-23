"use client";

import type { ReviewMode } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";
import { primaryDarkButton, secondaryButton } from "./review-ui";

export type ReviewActionsProps = {
  loading: boolean;
  reviewMode: ReviewMode;
  onApproveDocumentOnly: () => void;
  onPrimaryApprove: () => void;
  onSwitchToFinancial: () => void;
};

/**
 * Semantic safety (Integrity Blueprint §3/§16): a document-only save must never
 * look like a financial approval. In financial mode the primary CTA says it
 * records money; in document mode the primary CTA says it does NOT, and the
 * financial path is offered as an explicit mode switch instead of being hidden.
 */
export default function ReviewActions({
  loading,
  reviewMode,
  onApproveDocumentOnly,
  onPrimaryApprove,
  onSwitchToFinancial,
}: ReviewActionsProps) {
  const financial = reviewMode === "financial";
  const { t } = useI18n();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginTop: 20,
      }}
    >
      <button
        type="button"
        disabled={loading}
        style={primaryDarkButton(loading)}
        onClick={onPrimaryApprove}
      >
        {loading
          ? t("documents.review.actions.saving")
          : financial
            ? t("documents.review.actions.approveFinancial")
            : t("documents.review.actions.saveAsDocument")}
      </button>
      {!financial ? (
        <div style={primaryHintTextStyle}>
          {t("documents.review.actions.documentHint")}
        </div>
      ) : null}
      <div style={secondaryActionBoxStyle}>
        {financial ? (
          <>
            <div style={secondaryActionTextStyle}>
              {t("documents.review.actions.notFinancialHint")}
            </div>
            <button
              type="button"
              disabled={loading}
              style={secondaryButton(loading)}
              onClick={onApproveDocumentOnly}
            >
              {t("documents.review.actions.saveAsDocument")}
            </button>
          </>
        ) : (
          <>
            <div style={secondaryActionTextStyle}>
              {t("documents.review.actions.actuallyReceiptHint")}
            </div>
            <button
              type="button"
              disabled={loading}
              style={secondaryButton(loading)}
              onClick={onSwitchToFinancial}
            >
              {t("documents.review.actions.recordFinancial")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const secondaryActionBoxStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  borderRadius: TOKEN.radius.card,
  padding: 12,
  display: "grid",
  gap: 10,
};

const secondaryActionTextStyle = {
  color: TOKEN.ink.muted,
  fontSize: 13,
  fontWeight: 750,
  lineHeight: 1.5,
};

const primaryHintTextStyle = {
  color: TOKEN.ink.muted,
  fontSize: 12.5,
  fontWeight: 650,
  lineHeight: 1.5,
  textAlign: "center" as const,
};
