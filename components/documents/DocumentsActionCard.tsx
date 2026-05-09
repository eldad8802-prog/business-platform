"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

type DocumentsActionCardProps = {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
};

export default function DocumentsActionCard({
  icon,
  title,
  subtitle,
  href,
  onClick,
  disabled = false,
  ariaLabel,
}: DocumentsActionCardProps) {
  const content = (
    <div style={innerStyle}>
      <div style={iconWrapStyle} aria-hidden>
        {icon}
      </div>
      <div style={textBlockStyle}>
        <div style={titleStyle}>{title}</div>
        {subtitle ? <div style={subtitleStyle}>{subtitle}</div> : null}
      </div>
    </div>
  );

  if (href && !disabled) {
    return (
      <Link
        href={href}
        aria-label={ariaLabel || title}
        style={{ ...cardStyle, ...linkResetStyle }}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel || title}
      style={{
        ...cardStyle,
        ...buttonResetStyle,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {content}
    </button>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  minHeight: 96,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 22,
  padding: 16,
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
};

const linkResetStyle: CSSProperties = {
  textDecoration: "none",
  color: "inherit",
};

const buttonResetStyle: CSSProperties = {
  font: "inherit",
  color: "inherit",
  textAlign: "center",
};

const innerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  width: "100%",
  textAlign: "center",
};

const iconWrapStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 14,
  background: "#f3f4f6",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  lineHeight: 1,
  flexShrink: 0,
};

const textBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  fontWeight: 950,
  fontSize: 16,
  color: "#111827",
  lineHeight: 1.3,
  textAlign: "center",
};

const subtitleStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#6b7280",
  textAlign: "center",
  margin: 0,
};
