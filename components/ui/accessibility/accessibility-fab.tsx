"use client";

import { useEffect, useRef, useState } from "react";

/**
 * AccessibilityFab — a floating, always-available accessibility menu.
 *
 * Rendered once globally (in the root layout, before the app chrome). It is a
 * presentation-only control: every option toggles a CSS class or the document
 * zoom and persists the choice to localStorage. It never touches business
 * logic, data, routes, or the DB — it only adjusts how the current page looks
 * for the user who opened it.
 *
 * Placement: fixed to the bottom-inline-end corner (bottom-left in Dubiz's RTL
 * UI, opposite the top-inline-start SkipLink), so it never covers the primary
 * content column. RTL-safe via logical `insetInlineEnd`.
 *
 * a11y of the widget itself: the trigger carries a clear Hebrew `aria-label`,
 * `aria-expanded`/`aria-controls`; the panel is a labelled dialog that closes on
 * Escape and on outside-click and restores focus to the trigger.
 */

const STORAGE_KEY = "dubiz.a11y.prefs.v1";

// The new Dubiz turquoise CTA gradient — kept in sync with the brand primary.
const TURQUOISE_GRADIENT =
  "linear-gradient(90deg, #0F6F68 0%, #2EAAA2 55%, #8FE3DA 100%)";
const TURQUOISE_SHADOW = "0 18px 38px rgba(46, 170, 162, 0.35)";

type Prefs = {
  /** 0 = 100%, 1 = 110%, 2 = 125%. */
  zoomStep: number;
  underlineLinks: boolean;
  reduceMotion: boolean;
};

const DEFAULT_PREFS: Prefs = {
  zoomStep: 0,
  underlineLinks: false,
  reduceMotion: false,
};

const ZOOM_LEVELS = [1, 1.1, 1.25];

function readPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function applyPrefs(prefs: Prefs) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("a11y-underline-links", prefs.underlineLinks);
  root.classList.toggle("a11y-reduce-motion", prefs.reduceMotion);
  const zoom = ZOOM_LEVELS[prefs.zoomStep] ?? 1;
  // `zoom` scales px-based layouts too (unlike root font-size), and is honored
  // by all evergreen browsers. Reset to "" at 100% so we leave no inline style.
  root.style.zoom = zoom === 1 ? "" : String(zoom);
}

export function AccessibilityFab() {
  const [open, setOpen] = useState(false);
  // Lazy init reads saved prefs once at first render. On the server `readPrefs`
  // returns defaults; the trigger + closed panel don't depend on prefs, so the
  // client reading localStorage here never causes a hydration mismatch.
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync the saved prefs to the document (a DOM/external-system update) and
  // persist them, on mount and on every change. No setState here.
  useEffect(() => {
    applyPrefs(prefs);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable (private mode) — settings still apply for the session */
    }
  }, [prefs]);

  // Close on Escape and on outside-click; restore focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(t) &&
        triggerRef.current &&
        !triggerRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Avoid hydration mismatch: the trigger is static, so it's safe to render on
  // the server, but the panel content depends on client-only prefs.
  const update = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));

  const anyActive =
    prefs.zoomStep !== 0 || prefs.underlineLinks || prefs.reduceMotion;

  return (
    <>
      {/*
       * Presentation-only preference rules, scoped by classes the button toggles
       * on <html>. Kept here (not in globals.css) so the whole accessibility
       * feature is self-contained in one file. `zoom` for text size is set
       * inline on <html> by applyPrefs().
       */}
      <style>{`
        .a11y-underline-links a { text-decoration: underline !important; }
        .a11y-reduce-motion *, .a11y-reduce-motion *::before, .a11y-reduce-motion *::after {
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
          scroll-behavior: auto !important;
        }
      `}</style>
      <button
        ref={triggerRef}
        type="button"
        aria-label="פתח תפריט נגישות"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="dubiz-a11y-panel"
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          bottom: 20,
          insetInlineEnd: 20,
          zIndex: 2147482000,
          width: 54,
          height: 54,
          borderRadius: 999,
          border: "1px solid rgba(255, 255, 255, 0.30)",
          background: TURQUOISE_GRADIENT,
          color: "#ffffff",
          boxShadow: TURQUOISE_SHADOW,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        {/* Universal accessibility ("person") glyph. */}
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="4" r="2" fill="currentColor" />
          <path
            d="M3.5 8.5c2.5 1 5.3 1.5 8.5 1.5s6-.5 8.5-1.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M12 9.5V15m0 0-2.5 6M12 15l2.5 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          id="dubiz-a11y-panel"
          role="dialog"
          aria-label="תפריט נגישות"
          dir="rtl"
          style={{
            position: "fixed",
            bottom: 86,
            insetInlineEnd: 20,
            zIndex: 2147482000,
            width: 288,
            maxWidth: "calc(100vw - 40px)",
            background: "#ffffff",
            color: "#111827",
            borderRadius: 18,
            border: "1px solid #e5e7eb",
            boxShadow: "0 24px 60px rgba(15, 23, 42, 0.22)",
            padding: 16,
            fontFamily: "inherit",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>נגישות</h2>
            <button
              type="button"
              aria-label="סגור תפריט נגישות"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                color: "#6b7280",
                padding: 4,
              }}
            >
              ×
            </button>
          </div>

          {/* Text size */}
          <div style={rowStyle}>
            <span style={labelStyle}>גודל טקסט</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                aria-label="הקטן טקסט"
                onClick={() =>
                  update({ zoomStep: Math.max(0, prefs.zoomStep - 1) })
                }
                disabled={prefs.zoomStep === 0}
                style={stepBtnStyle(prefs.zoomStep === 0)}
              >
                A−
              </button>
              <button
                type="button"
                aria-label="הגדל טקסט"
                onClick={() =>
                  update({
                    zoomStep: Math.min(ZOOM_LEVELS.length - 1, prefs.zoomStep + 1),
                  })
                }
                disabled={prefs.zoomStep === ZOOM_LEVELS.length - 1}
                style={stepBtnStyle(prefs.zoomStep === ZOOM_LEVELS.length - 1)}
              >
                A+
              </button>
            </div>
          </div>

          {/* Underline links */}
          <ToggleRow
            label="הדגשת קישורים"
            checked={prefs.underlineLinks}
            onChange={(v) => update({ underlineLinks: v })}
          />

          {/* Reduce motion */}
          <ToggleRow
            label="הפחתת אנימציות"
            checked={prefs.reduceMotion}
            onChange={(v) => update({ reduceMotion: v })}
          />

          <button
            type="button"
            onClick={() => setPrefs(DEFAULT_PREFS)}
            disabled={!anyActive}
            style={{
              marginTop: 8,
              width: "100%",
              minHeight: 40,
              borderRadius: 999,
              border: "1px solid #e5e7eb",
              background: anyActive ? "#f9fafb" : "#ffffff",
              color: anyActive ? "#111827" : "#9ca3af",
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 600,
              cursor: anyActive ? "pointer" : "not-allowed",
            }}
          >
            איפוס הגדרות
          </button>
        </div>
      )}
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 0",
  borderBottom: "1px solid #f3f4f6",
};

const labelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: "#111827",
};

function stepBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    minWidth: 40,
    height: 36,
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: disabled ? "#f9fafb" : "#ffffff",
    color: disabled ? "#c7ccd4" : "#111827",
    fontFamily: "inherit",
    fontSize: 15,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          position: "relative",
          width: 46,
          height: 28,
          borderRadius: 999,
          border: "none",
          background: checked ? "#2EAAA2" : "#d1d5db",
          cursor: "pointer",
          transition: "background 150ms ease-out",
          padding: 0,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            insetInlineStart: checked ? 21 : 3,
            width: 22,
            height: 22,
            borderRadius: 999,
            background: "#ffffff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            transition: "inset-inline-start 150ms ease-out",
          }}
        />
      </button>
    </div>
  );
}
