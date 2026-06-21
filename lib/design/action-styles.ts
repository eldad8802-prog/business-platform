import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

type ActionOptions = {
  disabled?: boolean;
  fullWidth?: boolean;
  height?: number;
};

const disabledPrimary = "#B9C4D4";

export function primaryActionStyle({
  disabled,
  fullWidth,
  height = 52,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "10px 18px",
    borderRadius: TOKEN.radius.button,
    border: disabled ? "1px solid transparent" : TOKEN.action.primary.border,
    background: disabled ? disabledPrimary : TOKEN.action.primary.background,
    color: TOKEN.action.primary.color,
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

export function chipActionStyle(active = false): CSSProperties {
  return {
    minHeight: 38,
    padding: "7px 14px",
    borderRadius: TOKEN.radius.pill,
    border: active ? TOKEN.action.primary.border : TOKEN.action.glass.border,
    background: active ? TOKEN.action.primary.background : TOKEN.action.glass.background,
    color: active ? TOKEN.action.primary.color : TOKEN.action.glass.color,
    boxShadow: active ? TOKEN.action.primary.shadowSoft : TOKEN.action.glass.shadow,
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
