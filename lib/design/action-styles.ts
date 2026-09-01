import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { MIST } from "@/lib/design/mist";

type ActionOptions = {
  disabled?: boolean;
  fullWidth?: boolean;
  height?: number;
};

// Disabled reads the role tokens. The old value here was a hard-coded cool
// slate (#B9C4D4) that survived the Mist migration only because it sat in a
// bare const rather than in a style position the codemod inspected.
const disabledPrimaryBg = "var(--dz-action-disabled-bg)";
const disabledPrimaryText = "var(--dz-action-disabled-text)";

export function primaryActionStyle({
  disabled,
  fullWidth,
  height = 52,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "10px 18px",
    // Pill radius for the primary CTA. Secondary (glass) and danger keep the
    // standard button radius below.
    borderRadius: TOKEN.radius.pill,
    border: disabled ? "1px solid transparent" : TOKEN.action.primary.border,
    background: disabled ? disabledPrimaryBg : TOKEN.action.primary.background,
    color: disabled ? disabledPrimaryText : TOKEN.action.primary.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.bold,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? TOKEN.shadow.none : TOKEN.action.primary.shadow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
    lineHeight: 1.15,
    textDecoration: "none",
  };
}

export function glassActionStyle({
  disabled,
  fullWidth,
  height = 48,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "9px 16px",
    borderRadius: TOKEN.radius.button,
    border: TOKEN.action.glass.border,
    background: TOKEN.action.glass.background,
    color: TOKEN.action.glass.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.bold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.58 : 1,
    boxShadow: TOKEN.action.glass.shadow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
    lineHeight: 1.15,
    textDecoration: "none",
    backdropFilter: "blur(12px)",
  };
}

export function iconActionStyle(accent = false, disabled = false): CSSProperties {
  return {
    width: 42,
    height: 42,
    borderRadius: TOKEN.radius.pill,
    padding: 0,
    ...(accent
      ? primaryActionStyle({ disabled, height: 42 })
      : glassActionStyle({ disabled, height: 42 })),
    flexShrink: 0,
  };
}

/**
 * A chip is a SELECTION, not a primary action — so its active state takes the
 * milky-sage selection treatment (the one the sidebar already uses) rather than
 * the primary fill. Pair with `data-dz-selectable` and `aria-pressed` at the
 * call site to pick up hover/focus and to announce the state.
 */
export function chipActionStyle(active = false): CSSProperties {
  return {
    minHeight: 38,
    padding: "7px 14px",
    borderRadius: TOKEN.radius.pill,
    border: active
      ? `1px solid ${MIST.selectionBorder}`
      : TOKEN.action.glass.border,
    background: active ? MIST.selectionBg : TOKEN.action.glass.background,
    color: active ? MIST.selectionText : TOKEN.action.glass.color,
    boxShadow: active ? "none" : TOKEN.action.glass.shadow,
    fontFamily: "inherit",
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.bold,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.xs,
    whiteSpace: "nowrap",
  };
}

export function dangerActionStyle({
  disabled,
  fullWidth,
  height = 48,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "9px 16px",
    borderRadius: TOKEN.radius.button,
    border: TOKEN.action.danger.border,
    background: TOKEN.action.danger.background,
    color: TOKEN.action.danger.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.bold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.58 : 1,
    boxShadow: TOKEN.action.danger.shadow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
  };
}
