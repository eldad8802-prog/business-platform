"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

/**
 * Disclosure for pending documents outside the selected month (F-21). Shown
 * only when the all-time backlog exceeds the selected month's queue, so
 * "0 this month" is never presented as if nothing is pending anywhere. Carries
 * a real action — jump to the nearest other month that has pending documents.
 */
export default function BacklogBanner({
  olderCount,
  ctaMonthName,
  onShowOlder,
}: {
  olderCount: number;
  ctaMonthName?: string | null;
  onShowOlder: () => void;
}) {
  if (olderCount <= 0) return null;

  return (
    <div dir="rtl" style={wrap}>
      <div style={band}>
        <span style={text}>
          יש עוד {olderCount.toLocaleString("he-IL")} מסמכים שממתינים לבדיקה
          מחודשים אחרים.
        </span>
        <button type="button" onClick={onShowOlder} style={cta}>
          {ctaMonthName ? `הצג מסמכים מ${ctaMonthName}` : "הצג מסמכים קודמים"}
        </button>
      </div>
    </div>
  );
}

const wrap: CSSProperties = { marginBottom: 14 };

const band: CSSProperties = {
  borderRadius: TOKEN.radius.card,
  padding: "12px 14px",
  background: TOKEN.semantic.attention.bgSoft,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  color: TOKEN.semantic.attention.ink,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.5,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const text: CSSProperties = { minWidth: 0, flex: "1 1 220px" };

const cta: CSSProperties = {
  flexShrink: 0,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  background: TOKEN.surface.card,
  color: TOKEN.semantic.attention.ink,
  borderRadius: TOKEN.radius.pill,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};
