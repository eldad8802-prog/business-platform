/**
 * Design tokens — Inventory module.
 *
 * Values derive from the platform-wide {@link TOKEN} (see lib/design/tokens.ts).
 * Export names and shapes are preserved so existing components keep working.
 */
import { TOKEN } from "@/lib/design/tokens";

export const inventoryTheme = {
  pageBg: TOKEN.surface.page,
  cardBg: TOKEN.surface.card,
  cardBorder: TOKEN.border.DEFAULT,
  cardShadow: TOKEN.shadow.elevated,
  text: TOKEN.ink.primary,
  textMuted: TOKEN.ink.muted,
  /** Brand / link accent — refined success green. */
  accent: TOKEN.semantic.success.accent,
  accentDark: "#047857",
  /** Primary CTA — premium black, not indigo. */
  primaryBtn: TOKEN.surface.appChrome,
  primaryBtnHover: "#1F2937",
  successBtn: TOKEN.semantic.success.accent,
  danger: TOKEN.semantic.urgent.accent,
  warning: TOKEN.semantic.attention.accent,
  info: TOKEN.semantic.info.accent,
  purple: "#7c3aed",
} as const;

export const inventorySpacing = {
  xs: TOKEN.space.xs,
  sm: TOKEN.space.sm,
  md: TOKEN.space.md,
  lg: TOKEN.space.lg,
  xl: TOKEN.space.xl,
  xxl: TOKEN.space["2xl"],
  xxxl: TOKEN.space["3xl"],
} as const;

export const inventoryRadius = {
  sm: TOKEN.radius.input,
  md: TOKEN.radius.input,
  lg: TOKEN.radius.card,
  xl: TOKEN.radius.card,
  pill: TOKEN.radius.pill,
} as const;

export const inventoryLayout = {
  maxWidth: 960,
  maxWidthWide: 1080,
  bottomNavHeight: 64,
  safeBottomMobile: "calc(96px + env(safe-area-inset-bottom, 0px))",
} as const;

export type InventoryTone =
  | "danger"
  | "warning"
  | "purple"
  | "info"
  | "success"
  | "neutral";

export const inventoryToneStyles: Record<
  InventoryTone,
  { bg: string; border: string; color: string; iconBg: string }
> = {
  danger: {
    bg: TOKEN.semantic.urgent.bgSoft,
    border: TOKEN.semantic.urgent.border,
    color: TOKEN.semantic.urgent.ink,
    iconBg: TOKEN.semantic.urgent.bg,
  },
  warning: {
    bg: TOKEN.semantic.attention.bgSoft,
    border: TOKEN.semantic.attention.border,
    color: TOKEN.semantic.attention.ink,
    iconBg: TOKEN.semantic.attention.bg,
  },
  purple: {
    bg: "#f5f3ff",
    border: "#ddd6fe",
    color: "#5b21b6",
    iconBg: "#ede9fe",
  },
  info: {
    bg: TOKEN.semantic.info.bgSoft,
    border: TOKEN.semantic.info.border,
    color: TOKEN.semantic.info.ink,
    iconBg: TOKEN.semantic.info.bg,
  },
  success: {
    bg: TOKEN.semantic.success.bgSoft,
    border: TOKEN.semantic.success.border,
    color: TOKEN.semantic.success.ink,
    iconBg: TOKEN.semantic.success.bg,
  },
  neutral: {
    bg: TOKEN.surface.inset,
    border: TOKEN.border.DEFAULT,
    color: TOKEN.ink.secondary,
    iconBg: TOKEN.surface.inset,
  },
};

/** CSS custom properties for foundation stylesheet */
export const inventoryCssVars = `
  --inv-page-bg: ${inventoryTheme.pageBg};
  --inv-card-bg: ${inventoryTheme.cardBg};
  --inv-border: ${inventoryTheme.cardBorder};
  --inv-shadow: ${inventoryTheme.cardShadow};
  --inv-text: ${inventoryTheme.text};
  --inv-text-muted: ${inventoryTheme.textMuted};
  --inv-accent: ${inventoryTheme.accent};
  --inv-accent-dark: ${inventoryTheme.accentDark};
  --inv-primary: ${inventoryTheme.primaryBtn};
  --inv-danger: ${inventoryTheme.danger};
  --inv-warning: ${inventoryTheme.warning};
  --inv-info: ${inventoryTheme.info};
  --inv-max-width: ${inventoryLayout.maxWidth}px;
  --inv-radius-lg: ${inventoryRadius.xl}px;
  --inv-radius-md: ${inventoryRadius.lg}px;
  --inv-radius-sm: ${inventoryRadius.sm}px;
  --inv-radius-button: ${TOKEN.radius.button}px;
  --inv-gap: ${inventorySpacing.xl}px;
  --inv-bottom-safe: ${inventoryLayout.safeBottomMobile};
`;
