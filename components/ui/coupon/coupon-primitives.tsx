"use client";

/**
 * Coupon design primitives — shared building blocks for the coupon screen
 * package. Presentational only, token-driven (TOKEN.warm + COUPON). Faithful to
 * docs/coupon/coupon_screens_all.html. Design layer — no data, no backend.
 */

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON } from "@/lib/design/coupon-consumer";
import CanonicalBackButton from "@/components/ui/back-button";

const W = TOKEN.warm;

/* ---------------------------------------------------------- PhoneFrame ---- */

/**
 * "device" = a 390px phone mockup (the design gallery). "screen" = full-bleed
 * mobile app screen (mounted inside the real Dubiz feature). Same components,
 * two presentations.
 */
/**
 * Three presentations, one component tree.
 *
 *  - `device` — a *mock* of a phone: 390 cap, rounded, drop shadow. This is a
 *    preview of what the customer will see, and it is correct as a phone.
 *  - `screen` — a real phone-shaped application screen: 480 cap, square, full
 *    height. Right for a consumer experience the owner is browsing.
 *  - `app`    — a real application surface whose width belongs to the layout
 *    system, not to the phone metaphor. The frame keeps the screen treatment
 *    (square, full height, canvas background) but imposes **no cap**: the page
 *    supplies one from LAYOUT. Added so management surfaces stop inheriting a
 *    480px constraint from an ancestor that exists to describe a phone.
 *
 * `device` and `screen` behave exactly as before.
 */
type ScreenMode = "device" | "screen" | "app";
const ScreenModeContext = createContext<ScreenMode>("device");
export function ScreenModeProvider({ mode, children }: { mode: ScreenMode; children: ReactNode }) {
  return <ScreenModeContext.Provider value={mode}>{children}</ScreenModeContext.Provider>;
}

export function PhoneFrame({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const mode = useContext(ScreenModeContext);
  const app = mode === "app";
  // `app` shares every screen trait except the width authority.
  const screen = mode === "screen" || app;
  return (
    <div
      style={{
        width: "100%",
        maxWidth: app ? undefined : screen ? 480 : 390,
        margin: screen ? "0 auto" : undefined,
        background: W.canvas,
        borderRadius: screen ? 0 : 22,
        overflow: "hidden",
        boxShadow: screen ? "none" : "0 16px 40px rgba(35, 48, 43,0.14)",
        minHeight: screen ? "100vh" : 720,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        direction: "rtl",
        fontFamily: "'Heebo', system-ui, sans-serif",
        color: W.ink,
        lineHeight: 1.5,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function ScreenBody({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ flex: 1, padding: "8px 20px 22px", display: "flex", flexDirection: "column", ...style }}>
      {children}
    </div>
  );
}

export function Spring() {
  return <div style={{ flex: 1 }} />;
}

/* --------------------------------------------------------- ScreenHeader --- */

export function IconButton({
  children,
  onClick,
  light = false,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  light?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: light ? "rgba(255,255,255,0.2)" : W.surface,
        border: light ? "1px solid transparent" : `1px solid ${W.line}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

/** Text back button "חזרה" — the app-wide canonical control, pinned top-right
 *  (RTL start). `light` is accepted for call-site compatibility but ignored so
 *  the back affordance stays identical everywhere in the app. */
export function BackText({ onClick }: { onClick?: () => void; light?: boolean }) {
  return <CanonicalBackButton onClick={onClick} />;
}

/** Header: back ("חזרה") pinned top-right, title centered. */
export function ScreenHeader({
  title,
  action,
  absolute = false,
}: {
  title?: string;
  action?: ReactNode;
  absolute?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "20px 20px 8px",
        ...(absolute ? { position: "absolute", top: 0, right: 0, left: 0, zIndex: 2, paddingTop: 16 } : {}),
      }}
    >
      <div style={{ flexShrink: 0 }}>{action}</div>
      {title ? (
        <h1 style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.2px", margin: 0, flex: 1, textAlign: "center" }}>{title}</h1>
      ) : (
        <div style={{ flex: 1 }} />
      )}
      <div style={{ width: 72, flexShrink: 0 }} />
    </div>
  );
}

export function BackButton({ onClick }: { onClick?: () => void }) {
  return <BackText onClick={onClick} />;
}
export function CloseButton({ onClick }: { onClick?: () => void }) {
  return <BackText onClick={onClick} />;
}

/* ------------------------------------------------------------ FlowIntro --- */

export function FlowIntro({ eye, q }: { eye: string; q: string }) {
  return (
    <div style={{ margin: "14px 0 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: W.muted2, marginBottom: 9 }}>{eye}</div>
      <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.38, letterSpacing: "-0.35px", maxWidth: "19ch" }}>{q}</div>
    </div>
  );
}

/* ----------------------------------------------------------- ChoiceCard --- */

export function ChoiceCard({
  icon,
  title,
  why,
  selected = false,
  onClick,
}: {
  icon?: ReactNode;
  title: string;
  why?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        textAlign: "start",
        background: selected ? "rgba(36,105,102,0.05)" : W.surface,
        border: `1px solid ${selected ? W.teal : W.line}`,
        borderRadius: W.radius.card,
        padding: "16px 18px",
        boxShadow: W.shadow,
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      {icon ? (
        <span style={{ width: 40, height: 40, borderRadius: 11, background: W.surface2, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {icon}
        </span>
      ) : null}
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.2px", lineHeight: 1.35, color: W.ink }}>{title}</span>
        {why ? <span style={{ display: "block", fontSize: 13, color: W.muted, marginTop: 4, lineHeight: 1.5 }}>{why}</span> : null}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------- buttons --- */

const btnBase: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: W.radius.cta,
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

/** `disabled` is real (not just dimmed) so an invalid step cannot be submitted
 *  by keyboard or by a fast second tap. */
export function PrimaryButton({ children, onClick, style, disabled }: { children: ReactNode; onClick?: () => void; style?: CSSProperties; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ ...btnBase, height: 50, background: W.grad, color: "var(--dz-text-on-brand)", fontSize: 15, boxShadow: W.glow, ...(disabled ? { opacity: 0.55, cursor: "not-allowed", boxShadow: "none" } : null), ...style }}>
      {children}
    </button>
  );
}
export function SecondaryButton({ children, onClick, style, disabled }: { children: ReactNode; onClick?: () => void; style?: CSSProperties; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ ...btnBase, height: 44, background: W.surface, color: W.ink, border: `1px solid ${W.line}`, fontSize: 14, ...(disabled ? { opacity: 0.55, cursor: "not-allowed" } : null), ...style }}>
      {children}
    </button>
  );
}
export function WaButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...btnBase, height: 48, background: COUPON.accent.whatsapp, color: "var(--dz-text-on-brand)", fontSize: 15 }}>
      <svg viewBox="0 0 24 24" width={18} height={18} fill="var(--dz-text-on-brand)" aria-hidden><path d="M12 2a10 10 0 00-8.6 15l-1.4 5 5.1-1.3A10 10 0 1012 2z" /></svg>
      {children}
    </button>
  );
}
/** A real <button>: the old <div onClick> was unreachable by keyboard and
 *  invisible to assistive tech despite being a primary way out of a screen. */
export function GhostLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{ width: "100%", textAlign: "center", fontSize: 14, fontWeight: 600, color: W.tealDeep, cursor: "pointer", background: "none", border: "none", padding: 10, fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------- stroke Icon --- */

export function StrokeIcon({
  children,
  size = 20,
  color = W.tealDeep,
  width = 1.7,
  style,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={style}>
      {children}
    </svg>
  );
}
