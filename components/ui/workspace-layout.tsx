"use client";

import { useId, type ReactNode } from "react";

/**
 * WorkspaceLayout — the canonical Non-Interleaving Two-Region structural
 * primitive (Desktop Interaction System).
 *
 * IDENTITY (non-negotiable): exactly two regions that are cleanly separable —
 * a fixed-width `start` (inline-start, right in RTL) and a flexible `end`
 * (inline-end). In the collapsed responsive mode the regions CONCATENATE or
 * SWITCH; they are NEVER interleaved. A consumer whose content must interleave
 * (e.g. Review's preview between two editor parts) is NOT a WorkspaceLayout
 * consumer.
 *
 * OWNS: region structure, fixed/flexible sizing, RTL placement (logical / inline
 * axis), the parallel↔collapsed transition, and — for the switch mode — showing
 * exactly the consumer-chosen region. Scroll is `shared` (page scroll) in this
 * first implementation.
 *
 * DOES NOT OWN (agnostic, like the shell primitives): data, fetching, route,
 * selection meaning, workflow, keyboard routing, focus management, and — per the
 * ratified rule — the BREAKPOINT. WorkspaceLayout MUST NOT choose, measure,
 * infer, or default a breakpoint. `breakpointStep` is a consumer-selected step
 * from the DS breakpoint scale (DS owns the values; the consumer owns the
 * selection by measuring its own content). A missing `breakpointStep` is an API
 * usage error, not something the Layout guesses.
 *
 * This v0 implementation instantiates the axes with current evidence:
 *   responsiveBehavior = "switch"   · scrollModel = "shared".
 * `stack` and `split`/`sticky-aside` remain deferred DIS patterns; they enter
 * this implementation only when a real consumer proof requires them.
 *
 * No `window.innerWidth`: the parallel↔collapsed decision is a pure CSS media
 * query, SSR-safe via a `useId` scope (no hydration branch).
 */

export type WorkspaceLayoutProps = {
  /** Fixed-width region, inline-start (right in RTL). */
  start: ReactNode;
  /** Flexible region, inline-end. */
  end: ReactNode;
  /** Fixed width of the start region in the parallel (two-region) mode. */
  startWidth: number | string;
  /**
   * Consumer-selected step from the DS breakpoint scale (px). At/above it the
   * two regions show in parallel; below it the layout collapses per `responsive`.
   * REQUIRED — the Layout never chooses or defaults a breakpoint.
   */
  breakpointStep: number;
  /**
   * Collapsed-mode behavior. v0 instantiates only `switch`: exactly one region
   * shows below the breakpoint, and the consumer says which (`visible`), driven
   * by its own route/state — never by the Layout.
   */
  responsive: { mode: "switch"; visible: "start" | "end" };
  /** Scroll containment. v0 instantiates only `shared` (page scroll). */
  scrollModel?: "shared";
  /** Region landmark labels (accessibility). */
  startLabel?: string;
  endLabel?: string;
};

export function WorkspaceLayout({
  start,
  end,
  startWidth,
  breakpointStep,
  responsive,
  startLabel,
  endLabel,
}: WorkspaceLayoutProps) {
  // `scrollModel` is accepted for contract shape; v0 implements only "shared"
  // (the Layout imposes no overflow/height), so it is not read here.
  // SSR-safe unique scope so multiple instances / configurable values never
  // collide and there is no hydration mismatch.
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const startW = typeof startWidth === "number" ? `${startWidth}px` : startWidth;

  // shared scroll → the Layout imposes no overflow/height. Parallel via flex on
  // the inline axis (RTL-correct: start = first child = inline-start). Collapsed
  // = switch: base shows start; when the consumer chooses "end", show end.
  const css = `
[data-wsl="${scope}"] { display: block; box-sizing: border-box; }
[data-wsl="${scope}"] > .wsl-region { min-width: 0; box-sizing: border-box; }
[data-wsl="${scope}"] > .wsl-start { display: block; }
[data-wsl="${scope}"] > .wsl-end { display: none; }
@media (max-width: ${breakpointStep - 1}px) {
  [data-wsl="${scope}"][data-visible="end"] > .wsl-start { display: none; }
  [data-wsl="${scope}"][data-visible="end"] > .wsl-end { display: block; }
}
@media (min-width: ${breakpointStep}px) {
  [data-wsl="${scope}"] { display: flex; flex-direction: row; align-items: stretch; }
  [data-wsl="${scope}"] > .wsl-start { display: block; flex: 0 0 ${startW}; }
  [data-wsl="${scope}"] > .wsl-end { display: block; flex: 1 1 0; }
}
`;

  return (
    <div data-wsl={scope} data-visible={responsive.visible}>
      <style>{css}</style>
      <div className="wsl-region wsl-start" role="region" aria-label={startLabel}>
        {start}
      </div>
      <div className="wsl-region wsl-end" role="region" aria-label={endLabel}>
        {end}
      </div>
    </div>
  );
}
