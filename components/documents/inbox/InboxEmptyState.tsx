"use client";

import type { CSSProperties } from "react";
import { card, emptyState } from "@/app/documents/ui";

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
    body: "העלה מסמך או ייבא ממייל כדי לראות אותו כאן.",
  },
  no_pending: {
    title: "אין ממתינים לבדיקה",
    body: "כל המסמכים בחודש זה כבר עברו טיפול או שאושרו.",
  },
  no_approved: {
    title: "אין מסמכים מאושרים בחודש זה",
    body: "מסמכים מאושרים יופיעו כאן אחרי אישור מהמסך לבדיקה.",
  },
};

export default function InboxEmptyState({ variant }: { variant: InboxEmptyVariant }) {
  const c = COPY[variant];
  return (
    <div dir="rtl" style={{ ...emptyState, ...card }}>
      <div style={TITLE}>{c.title}</div>
      <p style={{ margin: 0, color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
        {c.body}
      </p>
    </div>
  );
}
