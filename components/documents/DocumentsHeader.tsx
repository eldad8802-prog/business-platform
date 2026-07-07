"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";
import BackButton from "@/components/ui/back-button";

type DocumentsHeaderProps = {
  title: string;
  backLabel?: string;
  onBack?: () => void;
  showBack?: boolean;
};

export default function DocumentsHeader({
  title,
  backLabel = "חזרה",
  onBack,
  showBack = true,
}: DocumentsHeaderProps) {
  return (
    <div dir="rtl" style={wrapperStyle}>
      {/* Right side in RTL = first DOM child of the grid */}
      <div style={{ ...sideStyle, justifyContent: "flex-start" }}>
        {showBack ? (
          <BackButton onClick={onBack} label={backLabel} />
        ) : (
          <div style={spacerStyle} />
        )}
      </div>

      <div style={titleStyle}>{title}</div>

      {/* Left side in RTL = third DOM child of the grid */}
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
