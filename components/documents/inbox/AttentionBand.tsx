"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

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
  const { t } = useI18n();
  if (pendingCount <= 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={BAND}>
        {t("documents.inbox.attentionBand", { count: pendingCount })}
      </div>
    </div>
  );
}
