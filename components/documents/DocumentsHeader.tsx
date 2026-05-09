"use client";

import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";

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
            {backLabel}
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
  background: "#ffffff",
  borderBottom: "1px solid #e5e7eb",
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
  width: 44,
  height: 44,
};

const titleStyle: CSSProperties = {
  textAlign: "center",
  fontWeight: 800,
  fontSize: 16,
  color: "#111827",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const backBtnStyle: CSSProperties = {
  minHeight: 40,
  padding: "0 12px",
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#111827",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
