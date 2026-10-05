"use client";

import { useCallback, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  acquireBackLock,
  getBackTarget,
  getTrailVersion,
  releaseBackLock,
  subscribeTrail,
} from "@/lib/navigation/back-nav/trail-runtime";
import { fallbackFor, labelForDestination, screenKeyOf, HOME_FALLBACK } from "@/lib/navigation/back-nav/route-registry";
import { pathnameOf, toSafeInternalPath } from "@/lib/navigation/back-nav/safe-path";
import styles from "./back-button.module.css";

/**
 * BackButton — the ONE canonical back control for the whole app: an arrow in
 * a round button. Placement (start edge = right in RTL) is the caller's job;
 * the visual and the behavior are fixed here.
 *
 * Where it goes (see lib/navigation/back-nav):
 *  1. The screen the user ACTUALLY came from, when the navigation trail can
 *     verify it — via `history.go(-n)`, so that screen comes back with its
 *     state and scroll, and browser Back/Forward stay consistent.
 *  2. Otherwise (direct link, new tab, a chain crossing accounts) the screen's
 *     declared fallback parent — `fallback` prop, else the route registry —
 *     validated as a safe in-app path and opened with `replace` (no loops).
 *     In this mode the button shows the destination as a visible label
 *     ("לרשימת המסמכים") instead of pretending it is "back".
 *
 * `onClick` is for in-screen steps (a sub-view inside one route, a wizard step
 * held in state): it replaces the history logic entirely.
 * `onBeforeLeave` lets a screen with unsaved changes intercept: call
 * `proceed()` to continue.
 *
 * Rapid / repeated activations are coalesced: one press moves one screen.
 */
export type BackButtonProps = {
  /** Fallback parent path when no verified origin exists (overrides registry). */
  fallback?: string;
  /** Visible label for the fallback, phrased as a destination ("למסמכים"). */
  fallbackLabel?: string;
  /** In-screen back (state step). Bypasses the history logic. */
  onClick?: () => void;
  /** Accessible name for the in-screen (`onClick`) mode. */
  label?: string;
  /** Unsaved-changes interception; call `proceed` to leave. */
  onBeforeLeave?: (proceed: () => void) => void;
  /**
   * Root screens only: render nothing unless a verified in-app origin exists
   * (a root never needs a fallback "back").
   */
  hideWithoutOrigin?: boolean;
  className?: string;
  style?: CSSProperties;
};

const ONCLICK_DEBOUNCE_MS = 350;

function useTrailVersion(): number {
  return useSyncExternalStore(subscribeTrail, getTrailVersion, () => -1);
}

/** What this screen's back would do right now (also usable by custom UIs). */
export function useBackDestination(fallback?: string, fallbackLabel?: string) {
  const pathname = usePathname() || "/";
  const version = useTrailVersion();
  const declared = fallbackFor(pathname);
  const explicit = fallback ? toSafeInternalPath(fallback) : null;
  const fb = explicit
    ? {
        url: explicit,
        label:
          fallbackLabel ??
          (pathnameOf(explicit) === pathnameOf(declared.url) ? declared.label : labelForDestination(explicit)),
      }
    : declared;
  // Before the trail is known (SSR / first paint) the neutral round form is
  // rendered: never claim an origin or a fallback that is not yet verified.
  const target = version < 0 ? null : getBackTarget();
  return { target, fallback: fb, pathname };
}

/**
 * Imperative back for code that hands a "back" callback to a child component
 * (`onExit`, `onBack`): same rules as the button — verified origin first,
 * else the validated fallback via replace; coalesces rapid calls.
 */
export function useGoBack(fallback?: string): () => void {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const explicit = fallback ? toSafeInternalPath(fallback) : null;
  const fallbackUrl = explicit ?? fallbackFor(pathname).url;
  return useCallback(() => {
    if (!acquireBackLock()) return;
    const live = getBackTarget();
    if (live.kind === "history") {
      window.history.go(live.delta);
      return;
    }
    const here = `${window.location.pathname}${window.location.search}`;
    let dest = toSafeInternalPath(fallbackUrl) ?? HOME_FALLBACK.url;
    if (screenKeyOf(dest) === screenKeyOf(here)) dest = HOME_FALLBACK.url;
    if (screenKeyOf(dest) === screenKeyOf(here)) {
      releaseBackLock();
      return;
    }
    router.replace(dest);
  }, [fallbackUrl, router]);
}

export default function BackButton({
  fallback,
  fallbackLabel,
  onClick,
  label,
  onBeforeLeave,
  hideWithoutOrigin,
  className,
  style,
}: BackButtonProps) {
  const lastClick = useRef(0);
  const { target, fallback: fb, pathname } = useBackDestination(fallback, fallbackLabel);
  const navigate = useGoBack(fb.url);

  const handleClick = () => {
    if (onClick) {
      const now = Date.now();
      if (now - lastClick.current < ONCLICK_DEBOUNCE_MS) return;
      lastClick.current = now;
      onClick();
      return;
    }
    if (onBeforeLeave) onBeforeLeave(navigate);
    else navigate();
  };

  if (hideWithoutOrigin && !onClick && target?.kind !== "history") return null;

  const showFallbackLabel = !onClick && target?.kind === "none";
  const accessibleName = onClick ? (label ?? "חזרה") : showFallbackLabel ? fb.label : "חזרה";
  const mode = onClick ? "step" : !target ? "pending" : target.kind === "history" ? "history" : "fallback";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={accessibleName}
      title={accessibleName}
      data-dz-back={mode}
      // The destination this press will go to (verified origin, or the
      // fallback) — an in-app path; lets QA prove every press lands on the
      // target that was computed.
      data-dz-back-target={onClick ? undefined : target?.kind === "history" ? target.url : target ? fb.url : undefined}
      data-dz-back-path={pathname}
      className={[styles.root, showFallbackLabel ? styles.withLabel : "", className ?? ""].join(" ").trim()}
      style={style}
    >
      <span className={styles.icon}>
        <BackArrowIcon />
      </span>
      {showFallbackLabel ? <span className={styles.label}>{fb.label}</span> : null}
    </button>
  );
}

/** Back arrow, drawn pointing right (= back in RTL); mirrored for LTR in CSS. */
export function BackArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * CloseButton — the round companion of BackButton for DISMISSING (a sheet, an
 * overlay, a flow the user abandons). It never navigates by itself: the caller
 * decides what closing means (including any unsaved-changes confirmation).
 * Same shape and tap target as back, different glyph and name, so "close" is
 * never mistaken for "back".
 */
export function CloseButton({
  onClick,
  label = "סגירה",
  className,
  style,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-dz-close=""
      className={[styles.root, className ?? ""].join(" ").trim()}
      style={style}
    >
      <span className={styles.icon}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </span>
    </button>
  );
}
