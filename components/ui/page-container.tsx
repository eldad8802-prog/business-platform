import type { CSSProperties, ReactNode } from "react";
import { LAYOUT, type PageIntent } from "@/lib/design/tokens";

/**
 * PageContainer v2 — the canonical page-width primitive
 * (Adaptive + Native Architecture Specification v1, §5; owner-approved).
 *
 * A screen declares an INTENT, never a number:
 *   focused  (560)  — login / short forms / focused settings
 *   standard (760)  — reading, rich wizards, basic CRUD
 *   content  (960)  — module hubs / composed home surfaces
 *   data     (1280) — lists, tables, dashboards
 *   full     (none) — special visual surfaces (keeps gutters unless `bleed`)
 *
 * Contract:
 *  - Widths come only from LAYOUT.width; changing a screen's width is a
 *    code-review decision (a different intent), not a new literal.
 *  - Renders `data-page-intent` so tests/CI can assert that every product
 *    page declares its intent (anti-drift substrate, Spec §29).
 *  - Horizontal padding only (responsive clamp from LAYOUT.gutter); the App
 *    Shell owns bottom-bar/sidebar offsets and safe-area handling.
 *  - RTL-safe via logical properties.
 *
 * `size` (narrow/standard/wide/full) is the pre-v2 API — kept as a mapped,
 * deprecated alias so early adopters migrate without churn.
 */

export type PageContainerSize = "narrow" | "standard" | "wide" | "full";

const LEGACY_SIZE_TO_INTENT: Record<PageContainerSize, PageIntent> = {
  narrow: "focused",
  standard: "standard",
  wide: "data",
  full: "full",
};

const MAX_WIDTH: Record<PageIntent, number | undefined> = {
  focused: LAYOUT.width.focused,
  standard: LAYOUT.width.standard,
  content: LAYOUT.width.content,
  data: LAYOUT.width.data,
  full: undefined,
};

export function PageContainer({
  intent,
  size,
  as: Tag = "main",
  bleed = false,
  className,
  style,
  children,
}: {
  /** The canonical width intent. Preferred over `size`. */
  intent?: PageIntent;
  /** @deprecated pre-v2 alias — use `intent`. */
  size?: PageContainerSize;
  /** Defaults to `main`: one landmark per page, owned by the container. */
  as?: "div" | "main" | "section";
  /** full-bleed surfaces only: drops the horizontal gutters too. */
  bleed?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const resolved: PageIntent =
    intent ?? (size ? LEGACY_SIZE_TO_INTENT[size] : "standard");

  return (
    <Tag
      className={className}
      data-page-intent={resolved}
      style={{
        width: "100%",
        maxWidth: MAX_WIDTH[resolved],
        marginInline: "auto",
        paddingInline: bleed
          ? undefined
          : `clamp(${LAYOUT.gutter.compact}px, 3vw, ${LAYOUT.gutter.expanded}px)`,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
