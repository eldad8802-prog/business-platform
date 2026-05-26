"use client";

import { card } from "@/app/(shell)/documents/ui";
import ReviewOutcomeRow from "./ReviewOutcomeRow";
import { primaryDarkButton, secondaryButton } from "./review-ui";

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
        ...card,
        borderRadius: 18,
        borderColor: "#dfe7f3",
        maxWidth: 620,
        width: "100%",
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: 999,
          background: "#22c55e",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 54,
          fontWeight: 950,
          margin: "4px auto 18px",
        }}
      >
        ✓
      </div>
      <h2
        style={{
          margin: 0,
          color: "#0f172a",
          fontSize: 22,
          lineHeight: 1.3,
          fontWeight: 950,
        }}
      >
        המסמך אושר בהצלחה!
      </h2>
      <p
        style={{
          margin: "8px 0 18px",
          color: "#64748b",
          fontSize: 14,
          fontWeight: 850,
          lineHeight: 1.6,
        }}
      >
        {approvedAs === "financial"
          ? `${directionDisplay} בסך ${amountDisplay} נוספה לדוחות ${new Date().getFullYear()}.`
          : "המסמך נשמר כמידע עסקי ולא השפיע על הדוחות."}
      </p>

      <div
        style={{
          border: "1px solid #bbf7d0",
          background: "#f0fdf4",
          borderRadius: 12,
          textAlign: "right",
          overflow: "hidden",
        }}
      >
        <ReviewOutcomeRow
          icon="▤"
          title="נוסף לדוח החודשי"
          body={
            approvedAs === "financial"
              ? "התנועה מופיעה בדוח החודש"
              : "המסמך נשמר בארכיון המסמכים"
          }
        />
        <ReviewOutcomeRow
          icon="₪"
          title="עודכן בהוצאות העסק"
          body={
            approvedAs === "financial"
              ? "הנתונים הפיננסיים עודכנו"
              : "לא נוצרה תנועה פיננסית"
          }
        />
        <ReviewOutcomeRow
          icon="⌕"
          title="זמין בחיפוש"
          body="ניתן לחפש לפי ספק, תאריך, סכום וסטטוס"
        />
        <ReviewOutcomeRow
          icon="□"
          title="ייכלל בחבילה לרו״ח"
          body={
            approvedAs === "financial"
              ? "ייצא בקובצי הייצוא הבאים"
              : "יישמר לעיון פנימי"
          }
        />
      </div>

      <div
        style={{
          marginTop: 18,
          border: "1px solid #dfe7f3",
          borderRadius: 14,
          padding: 14,
          background: "#ffffff",
        }}
      >
        <div style={{ color: "#0f172a", fontSize: 14, fontWeight: 950, marginBottom: 10 }}>
          מה תרצה לעשות עכשיו?
        </div>
        <button
          type="button"
          style={{ ...primaryDarkButton(false), background: "#002b6b" }}
          onClick={onNext}
        >
          {nextPendingDocumentId
            ? "בדוק את המסמך הבא"
            : "חזור למסמכים שמחכים לבדיקה"}
          <span style={{ marginInlineStart: 10 }}>←</span>
        </button>
        <button
          type="button"
          style={{ ...secondaryButton(false), marginTop: 10 }}
          onClick={onHub}
        >
          חזור למרכז הפיננסי
        </button>
      </div>

      {approvedAs === "financial" ? (
        <button
          type="button"
          style={{
            border: "none",
            background: "transparent",
            color: "#002b6b",
            marginTop: 14,
            fontSize: 12,
            fontWeight: 900,
            cursor: "pointer",
          }}
          onClick={onSearch}
        >
          צפה בפרטי המסמך
        </button>
      ) : null}
    </section>
  );
}
