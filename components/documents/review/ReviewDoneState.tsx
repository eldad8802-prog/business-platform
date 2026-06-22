"use client";

import ReviewOutcomeRow from "./ReviewOutcomeRow";
import { primaryDarkButton, reviewCard, secondaryButton } from "./review-ui";
import { TOKEN } from "@/lib/design/tokens";

export type ReviewDoneStateProps = {
  approvedAs: "financial" | "document" | null;
  directionDisplay: string;
  amountDisplay: string;
  nextPendingDocumentId: number | null;
  onNext: () => void;
  onHub: () => void;
  onSearch: () => void;
};

export default function ReviewDoneState({
  approvedAs,
  directionDisplay,
  amountDisplay,
  nextPendingDocumentId,
  onNext,
  onHub,
  onSearch,
}: ReviewDoneStateProps) {
  return (
    <section
      style={{
        ...reviewCard,
        maxWidth: 660,
        width: "100%",
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 92,
          height: 92,
          borderRadius: 999,
          background: TOKEN.semantic.success.bg,
          color: TOKEN.semantic.success.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 48,
          fontWeight: TOKEN.weight.bold,
          margin: "4px auto 18px",
          boxShadow: TOKEN.shadow.elevated,
        }}
      >
        ✓
      </div>
      <h2
        style={{
          margin: 0,
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.hero,
          lineHeight: 1.3,
          fontWeight: TOKEN.weight.bold,
        }}
      >
        המסמך אושר בהצלחה
      </h2>
      <p
        style={{
          margin: "10px 0 20px",
          color: TOKEN.ink.muted,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.semibold,
          lineHeight: 1.6,
        }}
      >
        {approvedAs === "financial"
          ? `${directionDisplay} בסך ${amountDisplay} נשמרה כרשומה פיננסית מאושרת.`
          : "המסמך נשמר כמידע עסקי ולא יצר רשומה פיננסית."}
      </p>

      <div
        style={{
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.inset,
          borderRadius: TOKEN.radius.card,
          textAlign: "right",
          overflow: "hidden",
        }}
      >
        <ReviewOutcomeRow
          icon="✓"
          title="נשמר ב-Documents"
          body={
            approvedAs === "financial"
              ? "הרשומה זמינה ברשומות המאושרות"
              : "המסמך נשמר לתיעוד פנימי"
          }
        />
        <ReviewOutcomeRow
          icon="✓"
          title="זמין להמשך עבודה"
          body={
            approvedAs === "financial"
              ? "אפשר למצוא אותו בחיפוש ולהכליל בחומר לרו״ח"
              : "אפשר לחזור אליו מתוך מסמכי העסק"
          }
        />
      </div>

      <div
        style={{
          marginTop: 20,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.card,
          padding: 16,
          background: TOKEN.surface.card,
        }}
      >
        <div style={{ color: TOKEN.ink.primary, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, marginBottom: 12 }}>
          מה תרצה לעשות עכשיו?
        </div>
        <button type="button" style={primaryDarkButton(false)} onClick={onNext}>
          {nextPendingDocumentId ? "אמת את המסמך הבא" : "חזור לתור האימות"}
        </button>
        <button
          type="button"
          style={{ ...secondaryButton(false), marginTop: 10 }}
          onClick={onHub}
        >
          חזור למסמכים
        </button>
      </div>

      {approvedAs === "financial" ? (
        <button
          type="button"
          style={{
            border: "none",
            background: "transparent",
            color: TOKEN.brand.mid,
            marginTop: 14,
            fontSize: 13,
            fontWeight: TOKEN.weight.bold,
            cursor: "pointer",
          }}
          onClick={onSearch}
        >
          עבור לחיפוש
        </button>
      ) : null}
    </section>
  );
}
