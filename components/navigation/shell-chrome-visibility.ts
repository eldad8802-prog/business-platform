"use client";

import { useEffect } from "react";
import { useSyncExternalStore } from "react";

/**
 * Shell chrome visibility — a tiny shared signal so a full-screen surface (e.g.
 * a secretary sub-screen or modal) can hide the app's fixed bottom nav + FAB.
 *
 * The bottom bar renders as a sibling of the scroll container, so it forms its
 * own stacking context above page content — an in-page modal cannot cover it
 * with z-index alone. Rather than portal every modal, a screen that needs the
 * full viewport calls `useHideShellChrome(true)` and the bar removes itself.
 *
 * Reference-counted so overlapping callers compose correctly, and always
 * released on unmount.
 */
let hiddenCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function acquire(): () => void {
  hiddenCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hiddenCount = Math.max(0, hiddenCount - 1);
    emit();
  };
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): boolean {
  return hiddenCount > 0;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Read whether any surface currently requests the shell chrome be hidden. */
export function useShellChromeHidden(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Hide the shell chrome while `hidden` is true; automatically released. */
export function useHideShellChrome(hidden: boolean): void {
  useEffect(() => {
    if (!hidden) return;
    return acquire();
  }, [hidden]);
}
