"use client";

import type { ReviewMode } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/tokens";
import { primaryDarkButton, secondaryButton } from "./review-ui";

export type ReviewActionsProps = {
  loading: boolean;
  reviewMode: ReviewMode;
  isUnknown: boolean;
  onApproveDocumentOnly: () => void;
  onPrimaryApprove: () => void;
  onDismiss: () => void;
};

export default function ReviewActions({
  loading,
  reviewMode,
  isUnknown,
  onApproveDocumentOnly,
  onPrimaryApprove,
  onDismiss,
}: ReviewActionsProps) {
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
          : reviewMode === "financial"
            ? "אשר ושמור"
            : isUnknown
              ? "זה מסמך פיננסי"
              : "אשר ושמור"}
      </button>
      <div style={secondaryActionBoxStyle}>
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
      </div>
      <button
        type="button"
        disabled={loading}
        style={dismissButtonStyle(loading)}
        onClick={onDismiss}
      >
        לא רלוונטי · הסר מהתור
      </button>
    </div>
  );
}

function dismissButtonStyle(loading: boolean) {
  return {
    minHeight: 44,
    border: "none",
    background: "transparent",
    color: TOKEN.ink.muted,
    fontSize: 13,
    fontWeight: TOKEN.weight.bold,
    cursor: loading ? "not-allowed" : "pointer",
    textDecoration: "underline",
  } as const;
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
