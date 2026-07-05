"use client";

import { useSyncExternalStore } from "react";

/**
 * usePrefersReducedMotion — the shared WP1 A-8 motion primitive.
 *
 * Returns whether the user has asked the OS to reduce motion
 * (`prefers-reduced-motion: reduce`). Components read this boolean and drop or
 * shorten their animations/transitions accordingly — so motion is opt-out for
 * users who need it, without every component re-implementing the media query.
 *
 * Implemented with `useSyncExternalStore` (the React-recommended way to subscribe
 * to an external store such as a media query): SSR-safe (server snapshot = false)
 * and correct across live preference changes.
 *
 * Usage (pair with `motionSafe` for ergonomic inline styles):
 *   const reduced = usePrefersReducedMotion();
 *   style={{ transition: motionSafe(reduced, "transform 200ms ease", "none") }}
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Pick the motion-appropriate value: `animated` normally, `still` when the user
 * prefers reduced motion. Pure helper — keeps inline styles readable.
 *
 *   transition: motionSafe(reduced, `transform ${MS}ms`, "none")
 */
export function motionSafe<T>(prefersReduced: boolean, animated: T, still: T): T {
  return prefersReduced ? still : animated;
}
