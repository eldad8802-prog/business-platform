"use client";

import { useState } from "react";

/**
 * SkipLink — the reusable WP1 A-4 "skip to main content" control.
 *
 * Rendered as the first focusable element so a keyboard / screen-reader user can
 * jump straight past the navigation to the main content. It is **visually hidden
 * until focused** (it never affects the visual layout), and on focus it appears
 * as a small pill. RTL-safe (uses `insetInlineStart`, so it sits on the right in
 * Dubiz's RTL UI). Activating it moves focus to the target (which must carry
 * `id={targetId}` and `tabIndex={-1}`).
 *
 * Usage (once, globally): render <SkipLink /> before the chrome/nav, and put
 * `id="main-content" tabIndex={-1}` on the main content container.
 */
export function SkipLink({
  targetId = "main-content",
  label = "דלג לתוכן",
}: {
  targetId?: string;
  label?: string;
}) {
  const [focused, setFocused] = useState(false);

  const hiddenStyle: React.CSSProperties = {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  };

  const visibleStyle: React.CSSProperties = {
    position: "fixed",
    top: 8,
    insetInlineStart: 8,
    zIndex: 100000,
    padding: "10px 16px",
    borderRadius: 10,
    background: "#0a0a0f",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 700,
    textDecoration: "none",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.25)",
  };

  return (
    <a
      href={`#${targetId}`}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => {
        // Ensure focus actually moves to the target (not just the viewport).
        document.getElementById(targetId)?.focus();
      }}
      style={focused ? visibleStyle : hiddenStyle}
    >
      {label}
    </a>
  );
}
