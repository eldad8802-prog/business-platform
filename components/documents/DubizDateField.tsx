"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

export type DubizDateFieldProps = {
  /** "date" for a full day picker, "month" for a month/year picker. */
  type?: "date" | "month";
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  /** Extra style applied to the outer field container (e.g. marginTop). */
  style?: CSSProperties;
};

/**
 * Dubiz-styled wrapper around a native `type="date"` / `type="month"` input.
 *
 * The native input keeps all of its behaviour (keyboard, locale-aware picker),
 * but the raw Chrome/Windows chrome is hidden via the `.dz-native-date` utility
 * (see globals.css): the picker indicator fills the whole field invisibly, so
 * clicking anywhere opens the picker, and we render our own calendar glyph.
 */
export default function DubizDateField({
  type = "date",
  value,
  onChange,
  ariaLabel,
  style,
}: DubizDateFieldProps) {
  return (
    <div className="dz-datefield" style={{ ...fieldStyle, ...style }}>
      <span aria-hidden style={iconStyle}>
        <CalendarGlyph />
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        className="dz-native-date"
        style={inputStyle}
      />
    </div>
  );
}

function CalendarGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="16"
        rx="2.5"
        stroke={TOKEN.ink.muted}
        strokeWidth="1.8"
        fill="none"
      />
      <path
        d="M3 9h18M8 3v4M16 3v4"
        stroke={TOKEN.ink.muted}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const fieldStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 52,
  padding: "0 14px",
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  boxSizing: "border-box",
  transition: TOKEN.transition.base,
};

const iconStyle: CSSProperties = {
  display: "inline-flex",
  flexShrink: 0,
  lineHeight: 0,
};

const inputStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  padding: "14px 0",
  boxSizing: "border-box",
};
