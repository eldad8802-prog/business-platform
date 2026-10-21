"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";
import { formatNumber } from "@/lib/i18n/format";

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
  const { t, fmt } = useI18n();
  if (olderCount <= 0) return null;

  return (
    <div style={wrap}>
      <div style={band}>
        <span style={text}>
          {t("documents.inbox.backlogText", { count: formatNumber(olderCount, fmt) })}
        </span>
        <button type="button" onClick={onShowOlder} style={cta}>
          {ctaMonthName
            ? t("documents.inbox.backlogShowMonth", { month: ctaMonthName })
            : t("documents.inbox.backlogShowOlder")}
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
