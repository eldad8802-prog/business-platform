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
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 12,
        marginTop: 20,
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
            ? "אשר ושמור"
            : isUnknown
              ? "זה מסמך פיננסי"
              : "אשר ושמור"}
      </button>
    </div>
  );
}
