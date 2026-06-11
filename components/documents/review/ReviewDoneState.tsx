"use client";

import ReviewOutcomeRow from "./ReviewOutcomeRow";
import { primaryDarkButton, reviewCard, secondaryButton } from "./review-ui";

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
          background: "#ff8a2a",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 48,
          fontWeight: 950,
          margin: "4px auto 18px",
          boxShadow: "0 12px 26px rgba(255, 138, 42, 0.24)",
        }}
      >
        ✓
      </div>
      <h2
        style={{
          margin: 0,
          color: "#0d1b3d",
          fontSize: 26,
          lineHeight: 1.3,
          fontWeight: 950,
        }}
      >
        המסמך אושר בהצלחה
      </h2>
      <p
        style={{
          margin: "10px 0 20px",
          color: "#6b7899",
          fontSize: 15,
          fontWeight: 750,
          lineHeight: 1.6,
        }}
      >
        {approvedAs === "financial"
          ? `${directionDisplay} בסך ${amountDisplay} נשמרה כרשומה פיננסית מאושרת.`
          : "המסמך נשמר כמידע עסקי ולא יצר רשומה פיננסית."}
      </p>

      <div
        style={{
          border: "1px solid #e1e8f4",
          background: "#f8fbff",
          borderRadius: 18,
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
          border: "1px solid #e1e8f4",
          borderRadius: 18,
          padding: 16,
          background: "#ffffff",
        }}
      >
        <div style={{ color: "#0d1b3d", fontSize: 15, fontWeight: 950, marginBottom: 12 }}>
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
            color: "#075bff",
            marginTop: 14,
            fontSize: 13,
            fontWeight: 900,
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
