"use client";

/**
 * HScrollRow — horizontal scrolling strip for ticket rows. The scrollbar is
 * hidden reliably (independent of global CSS) via the wrapper-clip trick: the
 * inner scroller pads its bottom and pulls itself up, so the native scrollbar
 * lands below the outer `overflow:hidden` and is clipped away. Still scrollable
 * (swipe / drag / wheel). Presentational only.
 */

import { type CSSProperties, type ReactNode } from "react";

export function HScrollRow({
  children,
  gap = 12,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <div style={{ overflow: "hidden", ...style }}>
      <div
        className="dz-noscrollbar"
        style={{
          display: "flex",
          gap,
          overflowX: "auto",
          overflowY: "hidden",
          paddingBottom: 24,
          marginBottom: -24,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {children}
      </div>
    </div>
  );
}
