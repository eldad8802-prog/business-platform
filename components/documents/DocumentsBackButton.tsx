"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

/**
 * Canonical Documents back button: chevron + a visible "חזרה" label, DS-styled.
 * Single source of truth so every Documents screen shares one clear, accessible
 * back control. Pass `onClick`; override the visible/aria label via `label`.
 */
export default function DocumentsBackButton({
  onClick,
  label = "חזרה",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} style={backButtonStyle}>
      <BackChevronIcon />
      <span>{label}</span>
    </button>
  );
}

const backButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 40,
  padding: "0 14px",
  borderRadius: TOKEN.radius.button,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontFamily: "inherit",
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
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
