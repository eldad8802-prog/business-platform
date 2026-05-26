"use client";

import type { ReviewMode } from "@/lib/documents/review/types";
import { primaryDarkButton, secondaryButton } from "./review-ui";

export type ReviewActionsProps = {
  loading: boolean;
  reviewMode: ReviewMode;
  isUnknown: boolean;
  onApproveDocumentOnly: () => void;
  onPrimaryApprove: () => void;
};

export default function ReviewActions({
  loading,
  reviewMode,
  isUnknown,
  onApproveDocumentOnly,
  onPrimaryApprove,
}: ReviewActionsProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginTop: 16,
      }}
    >
      <button
        type="button"
        disabled={loading}
        style={secondaryButton(loading)}
        onClick={onApproveDocumentOnly}
      >
        שמור כמסמך מידע
      </button>
      <button
        type="button"
        disabled={loading}
        style={primaryDarkButton(loading)}
        onClick={onPrimaryApprove}
      >
        {loading
          ? "שומר..."
          : reviewMode === "financial"
            ? "אשר ושמור כעסקה"
            : isUnknown
              ? "זו קבלה / עסקה"
              : "אשר ושמור"}
      </button>
    </div>
  );
}
