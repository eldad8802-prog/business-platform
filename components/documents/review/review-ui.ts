import { TOKEN } from "@/lib/design/tokens";
import { glassActionStyle, primaryActionStyle } from "@/lib/design/action-styles";

export function basePageStyle() {
  return {
    minHeight: "100vh",
    background: TOKEN.surface.page,
    color: TOKEN.ink.primary,
  };
}

export function mainStyle() {
  return {
    maxWidth: 760,
    margin: "0 auto",
    padding: "0 18px 150px",
    display: "flex",
    flexDirection: "column" as const,
    gap: TOKEN.space.xl,
    boxSizing: "border-box" as const,
  };
}

export function primaryDarkButton(disabled?: boolean) {
  return {
    ...primaryActionStyle({ disabled, fullWidth: true, height: 58 }),
    width: "100%",
    fontSize: TOKEN.font.title,
  } as const;
}

export function secondaryButton(disabled?: boolean) {
  return {
    ...glassActionStyle({ disabled, fullWidth: true, height: 56 }),
    width: "100%",
  } as const;
}

export const reviewCard = {
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.xl,
  boxShadow: TOKEN.shadow.elevated,
};

export const reviewSoftPanel = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
};

export const reviewInput = {
  width: "100%",
  minHeight: 54,
  padding: "0 14px",
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.hover}`,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.semibold,
  boxSizing: "border-box" as const,
};

export const orangePill = {
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.semantic.attention.bgSoft,
  color: TOKEN.semantic.attention.ink,
  padding: "7px 12px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
};
