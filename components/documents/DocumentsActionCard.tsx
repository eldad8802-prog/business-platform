"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

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
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  boxShadow: TOKEN.shadow.elevated,
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
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
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
  fontWeight: TOKEN.weight.bold,
  fontSize: TOKEN.font.title,
  color: TOKEN.ink.primary,
  lineHeight: 1.3,
  textAlign: "center",
};

const subtitleStyle: CSSProperties = {
  fontSize: TOKEN.font.meta,
  lineHeight: 1.5,
  color: TOKEN.ink.muted,
  textAlign: "center",
  margin: 0,
};
