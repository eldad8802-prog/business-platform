"use client";

import { useSyncExternalStore } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import type { NavDestination } from "./nav-destinations";

/**
 * The fixed "יומן" tab (HOME v4, owner decision 18.11): the bar never changes, but where the tab leads follows what
 * the business really has —
 *   appointments ON  → /calendar (יומן ותורים);
 *   otherwise        → the Secretary's calendar: tasks, commitment due dates and payments, which every business
 *                      has. Never a "not active" screen.
 * While the flag is unknown the tab points at the always-available calendar (fail-closed: no promise of a module).
 */
export const DAY_CALENDAR_FALLBACK = "/secretary?screen=calendar";

export function useNavHref(dest: NavDestination): string {
  const appointments = useFeatureState("appointments", dest.key === "calendar");
  if (dest.key !== "calendar") return dest.href;
  return appointments === true ? dest.href : DAY_CALENDAR_FALLBACK;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/**
 * The query of the current URL (no useSearchParams: the shell layout has no Suspense boundary). Read at render —
 * the bar re-renders on every client navigation because its pathname changes — and on back/forward.
 */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search, () => "");
}

/** Active test for a resolved href that may carry a query (the Secretary calendar). */
export function isResolvedActive(pathname: string, search: string, href: string, isNavActive: (p: string, h: string) => boolean): boolean {
  const [path, query] = href.split("?");
  if (!query) return isNavActive(pathname, path);
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  return pathname === path && [...want.entries()].every(([k, v]) => have.get(k) === v);
}
