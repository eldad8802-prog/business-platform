"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

const BAND: CSSProperties = {
  borderRadius: TOKEN.radius.card,
  padding: "12px 14px",
  background: TOKEN.semantic.attention.bgSoft,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  color: TOKEN.semantic.attention.ink,
  fontSize: 13,
  fontWeight: 600,
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
