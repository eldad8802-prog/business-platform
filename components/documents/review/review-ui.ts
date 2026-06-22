import { TOKEN } from "@/lib/design/tokens";

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
    width: "100%",
    minHeight: 58,
    borderRadius: TOKEN.radius.button,
    border: "none",
    background: disabled
      ? TOKEN.ink.disabled
      : TOKEN.brand.gradient,
    color: TOKEN.ink.inverse,
    fontSize: TOKEN.font.title,
    fontWeight: TOKEN.weight.bold,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? TOKEN.shadow.none : TOKEN.shadow.elevated,
  } as const;
}

export function secondaryButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 56,
    borderRadius: TOKEN.radius.button,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    background: TOKEN.surface.card,
    color: TOKEN.brand.mid,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.bold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
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
