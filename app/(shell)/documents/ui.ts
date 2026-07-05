import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";

export const layout = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
  // DS v1 font — cascades to the whole Documents feature (the layout wraps every
  // documents route and exposes --font-heebo). The stack is only a fallback for
  // the brief moment before the web font loads.
  fontFamily:
    "var(--font-heebo), 'Heebo', 'Assistant', system-ui, -apple-system, sans-serif",
  // Root-cause guard for Hebrew glyph collision: Heebo is loaded only at weights
  // 300–600 (DS v1 forbids 700+). Any text that requests a heavier weight — an
  // explicit 700/800/900 OR a UA-default bold on <strong>/<h1>–<h6> — would make
  // the browser SYNTHESIZE bold by smearing glyphs wider, which overlaps Hebrew
  // letters (e.g. the ג in "גם" riding onto the ם). `none` disables that faux
  // bold feature-wide, so a missing weight renders with the nearest real Heebo
  // face (600) instead of a collided smear. Inherited → covers every descendant.
  fontSynthesis: "none",
};

export const header = {
  fontSize: TOKEN.font.hero,
  fontWeight: TOKEN.weight.bold,
  margin: 0,
  lineHeight: 1.25,
  color: TOKEN.ink.primary,
};

export const subheader = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  marginTop: 8,
  marginBottom: 0,
  lineHeight: 1.7,
};

export const topBar = {
  display: "grid",
  gridTemplateColumns: "48px 1fr 48px",
  alignItems: "center",
  marginBottom: 20,
};

export const backBtn = {
  ...glassActionStyle({ height: 40 }),
  width: 40,
  height: 40,
  // DS toolbar icon-buttons (back/close) are round.
  borderRadius: TOKEN.radius.pill,
  fontSize: 18,
  padding: 0,
};

export const topTitle = {
  textAlign: "center" as const,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.semibold,
  color: TOKEN.ink.primary,
};

export const card = {
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  boxShadow: TOKEN.shadow.elevated,
};

export const sectionTitle = {
  fontWeight: TOKEN.weight.bold,
  marginBottom: 10,
  color: TOKEN.ink.primary,
};

export const input = {
  width: "100%",
  padding: 12,
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.hover}`,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  marginTop: 6,
  boxSizing: "border-box" as const,
};

export const primaryBtn = {
  ...primaryActionStyle({ fullWidth: true, height: 54 }),
  width: "100%",
  minHeight: 54,
  padding: 14,
  fontSize: TOKEN.font.body,
  marginTop: 16,
};

export const secondaryBtn = {
  ...glassActionStyle({ fullWidth: true, height: 52 }),
  width: "100%",
  minHeight: 52,
  padding: 12,
  fontSize: TOKEN.font.body,
  marginTop: 10,
};

export const emptyState = {
  ...card,
  textAlign: "center" as const,
  color: TOKEN.ink.muted,
};

export const pageMain = {
  maxWidth: 760,
  margin: "0 auto",
  padding: 16,
  display: "flex",
  flexDirection: "column" as const,
  gap: 16,
};

export const hero = {
  borderRadius: TOKEN.radius.modal,
  padding: 22,
  background: TOKEN.brand.gradient,
  color: TOKEN.ink.inverse,
  boxShadow: TOKEN.shadow.floating,
  display: "flex",
  flexDirection: "column" as const,
  gap: 12,
};

export const heroKicker = {
  fontSize: TOKEN.font.meta,
  opacity: 0.8,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 10,
};

export const heroTitle = {
  margin: 0,
  fontSize: TOKEN.font.hero,
  lineHeight: 1.25,
  fontWeight: TOKEN.weight.bold,
};

export const heroSubText = {
  margin: "8px 0 0",
  color: "rgba(255,255,255,0.78)",
  fontSize: 14,
  lineHeight: 1.7,
};

export const alertError = {
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  borderRadius: TOKEN.radius.card,
  padding: 14,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.5,
};

export const alertSuccess = {
  border: `1px solid ${TOKEN.semantic.success.border}`,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
  borderRadius: TOKEN.radius.card,
  padding: 14,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.5,
};

// --- Phase 1 additions (do not modify existing tokens above) ---

export const cardTitle = {
  fontWeight: TOKEN.weight.bold,
  fontSize: TOKEN.font.title,
  marginBottom: 6,
  color: TOKEN.ink.primary,
  lineHeight: 1.35,
};

export const cardSubText = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  lineHeight: 1.6,
  margin: 0,
};

export const metricTile = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: 14,
  background: TOKEN.surface.inset,
  display: "flex",
  flexDirection: "column" as const,
  gap: 6,
  minWidth: 0,
};

export const editPillBtn = {
  ...glassActionStyle({ height: 40 }),
  padding: "10px 12px",
  fontSize: TOKEN.font.meta,
  whiteSpace: "nowrap" as const,
  minHeight: 40,
};

export const iconWrap = {
  width: 44,
  height: 44,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  lineHeight: 1,
  flexShrink: 0,
};
