"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";

type DocumentsHeaderProps = {
  title: string;
  backLabel?: string;
  onBack?: () => void;
  showBack?: boolean;
};

export default function DocumentsHeader({
  title,
  backLabel,
  onBack,
  showBack = true,
}: DocumentsHeaderProps) {
  const { t } = useI18n();
  return (
    <div style={wrapperStyle}>
      {/* Inline-start side (right in RTL) = first DOM child of the grid */}
      <div style={{ ...sideStyle, justifyContent: "flex-start" }}>
        {showBack ? (
          <BackButton onClick={onBack} label={backLabel ?? t("documents.common.back")} />
        ) : (
          <div style={spacerStyle} />
        )}
      </div>

      <div style={titleStyle}>{title}</div>

      {/* Inline-end side (left in RTL) = third DOM child of the grid */}
      <div style={{ ...sideStyle, justifyContent: "flex-end" }}>
        <div style={spacerStyle} />
      </div>
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 50,
  background: TOKEN.surface.card,
  borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: "10px 16px",
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  alignItems: "center",
  gap: 8,
};

const sideStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
};

const spacerStyle: CSSProperties = {
  width: 40,
  height: 40,
};

const titleStyle: CSSProperties = {
  textAlign: "center",
  fontWeight: TOKEN.weight.bold,
  fontSize: TOKEN.font.title,
  color: TOKEN.ink.primary,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
