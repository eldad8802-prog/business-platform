"use client";

import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";

/**
 * BackButton — the ONE canonical "חזרה" control for the whole app.
 *
 * Single source of truth so every internal screen shows an identical back
 * affordance: same size, font, color, icon, radius, border and behavior. Do
 * NOT restyle at call sites — placement (top-right in RTL) is the caller's job,
 * the visual is fixed here.
 *
 * Behavior: `onClick` wins; else navigate to `href`; else `router.back()`.
 */
export default function BackButton({
  onClick,
  href,
  label = "חזרה",
}: {
  onClick?: () => void;
  href?: string;
  label?: string;
}) {
  const router = useRouter();

  const handleClick = () => {
    if (onClick) return onClick();
    if (typeof href === "string" && href.trim()) return router.push(href);
    router.back();
  };

  return (
    <button type="button" onClick={handleClick} aria-label={label} style={BACK_BUTTON_STYLE}>
      <BackChevronIcon />
      <span>{label}</span>
    </button>
  );
}

/** Frozen canonical spec — identical rendering everywhere. */
export const BACK_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 40,
  padding: "0 14px",
  borderRadius: 14,
  border: "1px solid var(--dz-border)",
  background: "var(--dz-surface)",
  color: "var(--dz-brand)",
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
  cursor: "pointer",
  flexShrink: 0,
  WebkitTapHighlightColor: "transparent",
};

/** RTL back = chevron pointing to the right (toward the start edge). */
export function BackChevronIcon() {
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
