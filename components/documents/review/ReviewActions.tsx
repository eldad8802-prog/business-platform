"use client";

import type { ReviewMode } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/documents-theme";
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
          ? "שומר..."
          : financial
            ? "אשר ורשום כספית"
            : "שמור כמסמך מידע"}
      </button>
      {!financial ? (
        <div style={primaryHintTextStyle}>
          שמירה כמסמך מידע לא נרשמת בהוצאות, בדוחות או בחבילת רואה החשבון.
        </div>
      ) : null}
      <div style={secondaryActionBoxStyle}>
        {financial ? (
          <>
            <div style={secondaryActionTextStyle}>
              אם זה לא מסמך פיננסי, אפשר לשמור אותו כמידע בלבד.
            </div>
            <button
              type="button"
              disabled={loading}
              style={secondaryButton(loading)}
              onClick={onApproveDocumentOnly}
            >
              שמור כמסמך מידע
            </button>
          </>
        ) : (
          <>
            <div style={secondaryActionTextStyle}>
              זו בעצם קבלה או חשבונית? אפשר לרשום אותה כהוצאה או הכנסה.
            </div>
            <button
              type="button"
              disabled={loading}
              style={secondaryButton(loading)}
              onClick={onSwitchToFinancial}
            >
              רשום כספית
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
