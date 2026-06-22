"use client";

import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

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
  const router = useRouter();

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    router.back();
  };

  return (
    <div dir="rtl" style={wrapperStyle}>
      {/* Right side in RTL = first DOM child of the grid */}
      <div style={{ ...sideStyle, justifyContent: "flex-start" }}>
        {showBack ? (
          <button
            type="button"
            onClick={handleBack}
            aria-label={backLabel}
            style={backBtnStyle}
          >
            <BackChevronIcon />
          </button>
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
  gridTemplateColumns: "72px 1fr 72px",
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

const backBtnStyle: CSSProperties = {
  width: 40,
  height: 40,
  padding: 0,
  borderRadius: TOKEN.radius.button,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
