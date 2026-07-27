"use client";

import { useId, type ReactNode } from "react";

/**
 * Generic adaptive Master–Detail layout — STRUCTURAL ONLY.
 *
 * Two regions (master list + detail). Below `twoPaneMinWidth` (default 1024px)
 * exactly ONE region shows at a time — master by default, detail when
 * `showDetail` is true (the caller drives this from the route, never local
 * state). At/above the breakpoint both show side by side, master pinned to a
 * fixed width on the inline-start edge (right in RTL), detail taking the rest.
 *
 * Deliberately knows nothing about data fetching, routing, pathnames, status,
 * navigation, entity names, or any design tokens. It is a reusable shell for
 * any list↔detail screen (payments now; customers / suppliers / documents
 * later). Scroll is shared (the content region scrolls as one) — no imposed
 * nested scroll. Both regions get `min-width: 0` so long content never forces
 * horizontal overflow.
 */
export function MasterDetailLayout({
  master,
  detail,
  showDetail = false,
  masterWidth = 400,
  twoPaneMinWidth = 1024,
  gap = 0,
  masterLabel,
  detailLabel,
}: {
  master: ReactNode;
  detail: ReactNode;
  /** Single-pane widths only: true → show detail, false → show master. Route-driven. */
  showDetail?: boolean;
  /** Master column width (px) in two-pane mode. */
  masterWidth?: number;
  /** Viewport width (px) at/above which both panes show. */
  twoPaneMinWidth?: number;
  /** Space between the panes (px) in two-pane mode. */
  gap?: number;
  masterLabel?: string;
  detailLabel?: string;
}) {
  // SSR-safe unique scope so multiple instances / configurable values don't
  // collide and there is no hydration mismatch.
  const rawId = useId();
  const scope = rawId.replace(/[^a-zA-Z0-9_-]/g, "");

  const css = `
[data-md="${scope}"] { display: block; box-sizing: border-box; }
[data-md="${scope}"] > .md-region { min-width: 0; box-sizing: border-box; }
[data-md="${scope}"] > .md-master { display: block; }
[data-md="${scope}"] > .md-detail { display: none; }
/* Single pane (below the breakpoint): show exactly one region, route-driven.
   Scoped to max-width so it can never fight the two-pane rules at desktop. */
@media (max-width: ${twoPaneMinWidth - 1}px) {
  [data-md="${scope}"][data-show-detail="true"] > .md-master { display: none; }
  [data-md="${scope}"][data-show-detail="true"] > .md-detail { display: block; }
}
/* Two pane (at/above the breakpoint): both regions, master pinned inline-start. */
@media (min-width: ${twoPaneMinWidth}px) {
  [data-md="${scope}"] { display: flex; flex-direction: row; align-items: stretch; gap: ${gap}px; }
  [data-md="${scope}"] > .md-master { display: block; flex: 0 0 ${masterWidth}px; }
  [data-md="${scope}"] > .md-detail { display: block; flex: 1 1 0; }
}
`;

  return (
    <div data-md={scope} data-show-detail={showDetail ? "true" : "false"}>
      <style>{css}</style>
      <div className="md-region md-master" role="region" aria-label={masterLabel}>
        {master}
      </div>
      <div className="md-region md-detail" role="region" aria-label={detailLabel}>
        {detail}
      </div>
    </div>
  );
}
