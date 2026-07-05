"use client";

/**
 * Warm primitives — the seed of Dubiz's first shared design-system library.
 *
 * Isolated + tokenized: every value comes from `TOKEN.warm` / `TOKEN.weight`
 * (weights ≤600, no 700). These do NOT restyle any existing (cool/navy) consumer
 * — they are opt-in and used first by the Collection / Payments surfaces.
 *
 * Components: WarmCard · WarmButton · WarmPill · WarmChip · WarmField · WarmTimeline.
 * Styling only — no data, no capability, no product decisions.
 */

import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { TOKEN } from "@/lib/design/tokens";

const W = TOKEN.warm;
const WEIGHT = TOKEN.weight; // 400 / 500 / 600 only used here

/* ------------------------------------------------------------------ Card -- */

export function WarmCard({
  children,
  padding = 16,
  interactive = false,
  style,
}: {
  children: ReactNode;
  /** Inner padding (px). */
  padding?: number;
  /** Lift shadow on hover (for tappable cards). */
  interactive?: boolean;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        background: W.surface,
        border: `1px solid ${W.line}`,
        borderRadius: W.radius.card,
        boxShadow: interactive && hover ? W.shadowHover : W.shadow,
        padding,
        transition: "box-shadow 150ms ease-out",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Button -- */

type WarmButtonVariant = "primary" | "secondary" | "text";

export function WarmButton({
  variant = "primary",
  height = 48,
  fullWidth = false,
  leftIcon,
  children,
  disabled,
  style,
  ...rest
}: {
  variant?: WarmButtonVariant;
  height?: number;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [hover, setHover] = useState(false);

  const base: CSSProperties = {
    height,
    width: fullWidth ? "100%" : undefined,
    padding: variant === "text" ? "0 14px" : "0 18px",
    borderRadius: variant === "text" ? W.radius.control : W.radius.cta,
    border: variant === "secondary" ? `1px solid ${W.line}` : "none",
    fontFamily: "inherit",
    fontSize: 15,
    fontWeight: WEIGHT.semibold, // 600 — never 700
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    lineHeight: 1.15,
    transition:
      "background 280ms ease, box-shadow 280ms ease, transform 200ms ease, border-color 150ms",
  };

  const byVariant: CSSProperties =
    variant === "primary"
      ? {
          background: disabled ? W.muted2 : hover ? W.gradHover : W.grad,
          color: "#fff",
          boxShadow: disabled ? "none" : hover ? W.glowHover : W.glow,
          transform: hover && !disabled ? "translateY(-1px)" : "translateY(0)",
        }
      : variant === "secondary"
        ? {
            background: W.surface,
            color: W.ink,
            borderColor: hover ? W.muted2 : W.line,
          }
        : {
            background: "transparent",
            color: hover ? W.ink : W.muted,
          };

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...base, ...byVariant, ...style }}
      {...rest}
    >
      {leftIcon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ Pill -- */

export type WarmPillTone = "waiting" | "verified" | "partial" | "late";

/** Warm status signal — a pill, not a block. `verified`/`late` show a mark. */
export function WarmPill({
  tone,
  children,
  style,
}: {
  tone: WarmPillTone;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const s = W.status[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11.5,
        fontWeight: WEIGHT.semibold,
        color: s.ink,
        background: s.bg,
        borderRadius: W.radius.pill,
        padding: "2px 9px",
        ...style,
      }}
    >
      {tone === "late" ? (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: s.ink,
          }}
        />
      ) : null}
      {tone === "verified" ? <CheckGlyph size={12} color={s.ink} /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Chip -- */

export function WarmChip({
  selected = false,
  children,
  style,
  ...rest
}: {
  selected?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 40,
        padding: "0 16px",
        borderRadius: W.radius.control,
        border: `1px solid ${selected ? W.tealDeep : hover ? W.muted2 : W.line}`,
        background: selected ? "rgba(36, 105, 102, 0.05)" : W.surface,
        color: selected ? W.tealDeep : W.ink,
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: WEIGHT.semibold,
        cursor: "pointer",
        transition: "border-color 150ms, background 150ms, color 150ms",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- Field -- */

export function WarmField({
  label,
  children,
  style,
}: {
  label: string;
  /** The control (input/select) — rendered by the caller. */
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: "block", marginBottom: 15, ...style }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: WEIGHT.semibold,
          color: W.muted,
          margin: "0 2px 7px",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Shared field-control style — apply to <input>/<select> inside a WarmField. */
export function warmInputStyle(overrides?: CSSProperties): CSSProperties {
  return {
    width: "100%",
    height: 48,
    background: W.surface,
    border: `1px solid ${W.line}`,
    borderRadius: W.radius.control,
    padding: "0 14px",
    fontFamily: "inherit",
    fontSize: 15,
    color: W.ink,
    outline: "none",
    boxSizing: "border-box",
    ...overrides,
  };
}

/* -------------------------------------------------------------- Timeline -- */

export type WarmTimelineStep = {
  title: string;
  meta?: string;
  /** Completed milestone (filled dot + check). */
  done: boolean;
  /** "here now" marker on the latest reached step. */
  now?: boolean;
};

/** Read-only business-milestone timeline (created → sent → paid → verified). */
export function WarmTimeline({ steps }: { steps: WarmTimelineStep[] }) {
  return (
    <div style={{ margin: "4px 0" }}>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 13,
              paddingBottom: last ? 0 : 20,
              position: "relative",
            }}
          >
            {!last ? (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  right: 9,
                  top: 20,
                  bottom: 0,
                  width: 2,
                  background: W.line,
                }}
              />
            ) : null}
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1,
                background: step.done ? "rgba(36, 105, 102, 0.1)" : W.surface,
                border: step.done ? "none" : `2px solid ${W.line}`,
              }}
            >
              {step.done ? <CheckGlyph size={11} color={W.tealDeep} strokeWidth={3.2} /> : null}
            </span>
            <div>
              <div
                style={{
                  fontSize: 14.5,
                  fontWeight: step.done ? WEIGHT.semibold : WEIGHT.medium,
                  color: step.done ? W.ink : W.muted2,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                {step.title}
                {step.now ? (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: WEIGHT.semibold,
                      color: W.tealDeep,
                      background: "rgba(36, 105, 102, 0.08)",
                      borderRadius: W.radius.pill,
                      padding: "1px 8px",
                    }}
                  >
                    כאן עכשיו
                  </span>
                ) : null}
              </div>
              {step.meta ? (
                <div style={{ fontSize: 12, color: W.muted, marginTop: 1 }}>
                  {step.meta}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- glyph -- */

function CheckGlyph({
  size = 12,
  color,
  strokeWidth = 3,
}: {
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
