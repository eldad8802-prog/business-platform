"use client";

import type { CSSProperties } from "react";

const BAND: CSSProperties = {
  borderRadius: 18,
  padding: "12px 14px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#92400e",
  fontSize: 13,
  fontWeight: 800,
  lineHeight: 1.5,
};

export default function AttentionBand({
  pendingCount,
}: {
  pendingCount: number;
}) {
  if (pendingCount <= 0) return null;

  return (
    <div dir="rtl" style={{ marginBottom: 12 }}>
      <div style={BAND}>
        יש {pendingCount} מסמכים הממתינים לבדיקה בחודש הנבחר. מומלץ לעבור עליהם
        בטאב &quot;ממתינים&quot;.
      </div>
    </div>
  );
}
