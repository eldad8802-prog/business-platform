"use client";

import type { CSSProperties } from "react";

const TITLE: CSSProperties = {
  fontWeight: 950,
  fontSize: 16,
  marginBottom: 8,
  color: "#111827",
};

export type InboxEmptyVariant =
  | "no_documents_month"
  | "no_pending"
  | "no_approved";

const COPY: Record<InboxEmptyVariant, { title: string; body: string }> = {
  no_documents_month: {
    title: "אין מסמכים בחודש הזה",
    body: "העלה או ייבא מסמך כדי שהמערכת תזהה עסקה, תבקש ממך אישור קצר, ואז תעדכן דוחות וחבילה לרו״ח.",
  },
  no_pending: {
    title: "אין ממתינים לבדיקה",
    body: "כל המסמכים בחודש זה כבר טופלו. הדוח מבוסס על העסקאות שאושרו.",
  },
  no_approved: {
    title: "אין מסמכים מאושרים בחודש זה",
    body: "אחרי אישור מסמך כעסקה הוא יופיע בדוחות, בחיפוש ובחבילה לרו״ח.",
  },
};

export default function InboxEmptyState({ variant }: { variant: InboxEmptyVariant }) {
  const c = COPY[variant];
  return (
    <div
      dir="rtl"
      style={{
        background: "#ffffff",
        border: "1px solid #dfe7f3",
        borderRadius: 18,
        padding: 18,
        boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
        textAlign: "center",
      }}
    >
      <div style={TITLE}>{c.title}</div>
      <p style={{ margin: 0, color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
        {c.body}
      </p>
    </div>
  );
}
