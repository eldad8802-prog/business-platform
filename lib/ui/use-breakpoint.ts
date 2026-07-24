"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * SSR-safe responsive primitives.
 *
 * GOLDEN RULE: **layout is done in CSS** (media queries / Tailwind), not here.
 * The App Shell switches bottom-bar ↔ rail ↔ sidebar purely in CSS, so it has
 * zero hydration mismatch and never reads `window.innerWidth`. This hook is for
 * *behavioral* branches only (e.g. "render a bottom sheet vs a centered dialog")
 * in later phases — a consumer must tolerate the mobile-first SSR default until
 * mount.
 *
 * Built on `useSyncExternalStore` + `matchMedia`: the server snapshot is `false`
 * (→ mobile), the client subscribes to the media query and re-renders on change.
 * React swaps server→client snapshots without a hydration warning by design.
 */

// Tier breakpoints — must stay in sync with the App Shell CSS media queries.
const TABLET_MIN = "(min-width: 768px)";
const DESKTOP_MIN = "(min-width: 1024px)";

export type Breakpoint = "mobile" | "tablet" | "desktop";

/** Subscribe to a media query. Returns `false` during SSR / before mount. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = () =>
    typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;

  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Current device tier. SSR/first paint resolves to "mobile". */
export function useBreakpoint(): Breakpoint {
  const isTablet = useMediaQuery(TABLET_MIN);
  const isDesktop = useMediaQuery(DESKTOP_MIN);
  if (isDesktop) return "desktop";
  if (isTablet) return "tablet";
  return "mobile";
}
