import type { CSSProperties, ReactNode } from "react";

/**
 * Semantic page container — the single, opt-in width authority for the adaptive
 * era. It replaces (over time) the ~59 ad-hoc per-screen `maxWidth` constants;
 * NOTHING is migrated automatically — screens adopt it one at a time.
 *
 * Four sizes only, mapped to the width bands already present in the codebase:
 *   narrow (480)   — forms / focused content     · NOT for dashboards
 *   standard (760) — content pages / normal lists · NOT for wide worklists
 *   wide (1200)    — dashboards / tables          · NOT for narrow forms
 *   full (none)    — master-detail / workspace    · NOT for long reading text
 *
 * Horizontal padding is responsive via `clamp()` (mobile 16 → desktop 32); it
 * sets NO vertical/bottom padding — the App Shell owns the bottom-bar/sidebar
 * offsets. RTL-safe (logical `margin-inline`).
 */

export type PageContainerSize = "narrow" | "standard" | "wide" | "full";

const MAX_WIDTH: Record<PageContainerSize, number | undefined> = {
  narrow: 480,
  standard: 760,
  wide: 1200,
  full: undefined,
};

export function PageContainer({
  size = "standard",
  as: Tag = "div",
  className,
  style,
  children,
}: {
  size?: PageContainerSize;
  as?: "div" | "main" | "section";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Tag
      className={className}
      style={{
        width: "100%",
        maxWidth: MAX_WIDTH[size],
        marginInline: "auto",
        paddingInline: "clamp(16px, 4vw, 32px)",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
