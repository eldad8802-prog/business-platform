"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * AccessibilityTrigger — a docked entry point to the one global accessibility
 * panel (AccessibilityFab owns the panel and the saved preferences).
 *
 * Any surface with a permanent place for it (the desktop sidebar, the tablet
 * rail, the phone Home header, the auth and setup screens) renders this
 * trigger. While a trigger is VISIBLE on screen the floating button stands
 * down; where none is visible the floating button stays, so every layout at
 * every breakpoint keeps a way to reach accessibility.
 *
 * It talks to the panel through two window events, so it needs no provider:
 *   dubiz:a11y-toggle  (trigger → panel)  detail: { opener: HTMLElement }
 *   dubiz:a11y-state   (panel → triggers) detail: { open: boolean }
 */

export const A11Y_TOGGLE_EVENT = "dubiz:a11y-toggle";
export const A11Y_STATE_EVENT = "dubiz:a11y-state";
export const A11Y_TRIGGER_ATTR = "data-a11y-trigger";

export function AccessibilityGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="4" r="2" fill="currentColor" />
      <path d="M3.5 8.5c2.5 1 5.3 1.5 8.5 1.5s6-.5 8.5-1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 9.5V15m0 0-2.5 6M12 15l2.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AccessibilityTrigger({
  className,
  style,
  children,
  label = "נגישות",
}: {
  className?: string;
  style?: CSSProperties;
  /** Visible content; omit for an icon-only button (the label becomes aria-label). */
  children?: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onState = (e: Event) => setOpen(Boolean((e as CustomEvent<{ open: boolean }>).detail?.open));
    window.addEventListener(A11Y_STATE_EVENT, onState);
    return () => window.removeEventListener(A11Y_STATE_EVENT, onState);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      {...{ [A11Y_TRIGGER_ATTR]: "" }}
      className={className}
      style={style}
      aria-label={children ? undefined : label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="dubiz-a11y-panel"
      onClick={() => {
        if (!ref.current) return;
        window.dispatchEvent(new CustomEvent(A11Y_TOGGLE_EVENT, { detail: { opener: ref.current } }));
      }}
    >
      {children ?? <AccessibilityGlyph />}
    </button>
  );
}

/** True when some docked trigger is actually rendered (not display:none at this breakpoint). */
export function hasVisibleDockedTrigger(doc: Document): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>(`[${A11Y_TRIGGER_ATTR}]`)).some(
    (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"
  );
}
