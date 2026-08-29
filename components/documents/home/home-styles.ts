import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

/**
 * Documents home — presentation styles.
 *
 * All color / spacing / radius / font / weight / shadow values come from the
 * DS v1 warm `TOKEN` (Documents is the DS Anchor). Interactive states
 * (hover / active / focus-visible) and the responsive rules can't live in inline
 * React styles, so they are emitted as one scoped CSS string under
 * `.dz-docs-home`, generated from the tokens.
 *
 * The ONLY non-token values are the hero "glass" layer below: translucent WHITE
 * over the teal brand gradient. DS v1 has no token for white-at-alpha (its
 * palette is opaque warm), so these few values are centralized and documented
 * here as the single source for the hero's glass treatment (previously scattered
 * as inline `rgba(255,255,255,…)` literals on the old screen).
 */
const heroGlass = {
  sheen: "rgba(255, 255, 255, 0.18)",
  hairline: "rgba(255, 255, 255, 0.06)",
  eyebrowBg: "rgba(255, 255, 255, 0.16)",
  pdotRing: "rgba(255, 255, 255, 0.22)",
  ghostBg: "rgba(255, 255, 255, 0.14)",
  ghostBgHover: "rgba(255, 255, 255, 0.22)",
  ghostBorder: "rgba(255, 255, 255, 0.25)",
  importBg: "rgba(255, 255, 255, 0.13)",
  importBgHover: "rgba(255, 255, 255, 0.21)",
  importBorder: "rgba(255, 255, 255, 0.22)",
  divider: "rgba(255, 255, 255, 0.22)",
} as const;

export const pageShellStyle: CSSProperties = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
};

export const contentStyle: CSSProperties = {
  width: "100%",
  // max-width lives in homeCss() (base 600 → 720 @768 → content 960 @1024 with
  // the two-column recomposition) — an inline max-width can't be overridden by
  // the adaptive media queries. Spec v1 §20 (Documents cluster, owner-approved).
  margin: "0 auto",
  // Bottom padding leaves room for the fixed BottomBar (bumped to 148 on mobile
  // via the media query below).
  padding: `${TOKEN.space["2xl"]}px ${TOKEN.space.xl}px 118px`,
  boxSizing: "border-box",
};

/** One scoped stylesheet, generated from tokens. Injected once by the page. */
export function homeCss(): string {
  const T = TOKEN;
  const tr = T.transition.base;
  return `
  .dz-docs-home *{box-sizing:border-box;}

  /* ---------- Adaptive width + recomposition (Spec v1 §20, pilot-proven
     pattern): base 600 (mobile, unchanged) → 720 on medium → CONTENT intent
     (960) on expanded with a two-column band: pulse + stations in the start
     column, the capture hero sticky in the end column. Composition, not
     stretching; canonical breakpoints 768/1024 (LAYOUT.bp). ---------- */
  .dz-docs-home__content{max-width:600px;}
  @media (min-width:768px){
    .dz-docs-home__content{max-width:720px;}
  }
  @media (min-width:1024px){
    .dz-docs-home__content{
      max-width:960px;
      display:grid;
      grid-template-columns:1fr 1fr;
      column-gap:20px;
      align-items:start;
    }
    .dz-docs-home__content > *{grid-column:1 / -1;min-width:0;}
    .dz-docs-home__content > .dz-alert{grid-column:1 / -1;grid-row:1;}
    .dz-docs-home__content > .dz-pulse{grid-column:1;grid-row:2;}
    .dz-docs-home__content > .dz-sec-title{grid-column:1;grid-row:3;}
    .dz-docs-home__content > .dz-stations{grid-column:1;grid-row:4;}
    .dz-docs-home__content > .dz-hero{
      grid-column:2;
      grid-row:2 / span 3;
      position:sticky;
      top:16px;
      margin-top:0;
    }
  }

  /* ---------------- Pulse ---------------- */
  .dz-pulse{
    background:${T.surface.card};
    border:1px solid ${T.border.DEFAULT};
    border-radius:${T.dsv1.radius.sheet}px;
    padding:${T.space.xl}px;
    box-shadow:${T.shadow.elevated};
  }
  .dz-pulse__row{display:flex;align-items:flex-end;justify-content:space-between;gap:${T.space.md}px;}
  .dz-pulse__lbl{font-size:${T.font.meta}px;color:${T.ink.meta};font-weight:${T.weight.medium};}
  .dz-pulse__net{font-size:${T.font.hero}px;font-weight:${T.weight.semibold};letter-spacing:-.6px;margin-top:2px;color:${T.ink.primary};}
  .dz-pulse__cur{font-size:${T.font.title}px;opacity:.5;margin-inline-end:1px;}
  .dz-pulse__delta{display:inline-flex;align-items:center;gap:4px;font-size:${T.font.meta}px;font-weight:${T.weight.semibold};padding:4px 10px;border-radius:${T.radius.pill}px;white-space:nowrap;}
  .dz-pulse__delta--up{color:${T.semantic.success.ink};background:${T.semantic.success.bg};}
  .dz-pulse__delta--down{color:${T.semantic.urgent.ink};background:${T.semantic.urgent.bg};}
  .dz-pulse__delta--flat{color:${T.ink.muted};background:${T.surface.inset};}
  .dz-meter{display:flex;height:9px;border-radius:${T.radius.pill}px;overflow:hidden;margin:${T.space.lg}px 0 ${T.space.md}px;background:${T.surface.inset};}
  .dz-meter__inc{background:${T.brand.gradient};}
  .dz-meter__exp{background:${T.semantic.urgent.ink};}
  .dz-legend{display:flex;gap:${T.space.xl}px;}
  .dz-legend__it{display:flex;align-items:center;gap:${T.space.sm}px;}
  .dz-legend__sw{width:9px;height:9px;border-radius:3px;}
  .dz-legend__sw--inc{background:${T.semantic.success.ink};}
  .dz-legend__sw--exp{background:${T.semantic.urgent.ink};}
  .dz-legend__k{font-size:${T.font.meta}px;color:${T.ink.meta};}
  .dz-legend__v{font-size:${T.font.body}px;font-weight:${T.weight.semibold};margin-inline-start:2px;color:${T.ink.primary};}

  /* ---------------- Hero ---------------- */
  .dz-hero{
    position:relative;overflow:hidden;
    background:${T.brand.gradient};
    border-radius:${T.dsv1.radius.sheet}px;
    padding:${T.space["2xl"]}px ${T.space.xl}px ${T.space.xl}px;
    color:${T.ink.inverse};
    box-shadow:${T.shadow.floating};
    margin-top:${T.space["2xl"]}px;
  }
  .dz-hero::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 1px 0 ${heroGlass.sheen},inset 0 0 0 1px ${heroGlass.hairline};pointer-events:none;}
  .dz-hero__eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:${T.font.meta}px;font-weight:${T.weight.semibold};background:${heroGlass.eyebrowBg};padding:5px 11px;border-radius:${T.radius.pill}px;position:relative;}
  .dz-hero__pdot{width:6px;height:6px;border-radius:${T.radius.pill}px;background:${T.ink.inverse};box-shadow:0 0 0 3px ${heroGlass.pdotRing};}
  .dz-hero__title{font-size:${T.font.display}px;font-weight:${T.weight.semibold};letter-spacing:-.3px;margin:${T.space.md}px 0 5px;position:relative;}
  .dz-hero__sub{font-size:${T.font.body}px;opacity:.85;margin:0 0 ${T.space.lg}px;position:relative;font-weight:${T.weight.regular};}
  .dz-hero__hint{display:flex;align-items:center;gap:6px;font-size:${T.font.caption}px;opacity:.75;margin-top:${T.space.md}px;position:relative;font-weight:${T.weight.regular};}

  .dz-cta-row,.dz-hero__imports{display:grid;grid-template-columns:1fr 1fr;gap:${T.space.md}px;position:relative;}
  .dz-cta{display:flex;align-items:center;justify-content:center;gap:${T.space.sm}px;border-radius:${T.radius.card}px;padding:${T.space.md}px;font-size:${T.font.title}px;font-weight:${T.weight.semibold};font-family:inherit;border:none;cursor:pointer;transition:transform ${tr},box-shadow ${tr},background ${tr};}
  .dz-cta svg{width:21px;height:21px;flex:none;}
  .dz-cta--solid{background:${T.surface.card};color:${T.brand.mid};box-shadow:${T.shadow.elevated};}
  .dz-cta--solid:hover{transform:translateY(-2px);box-shadow:${T.shadow.floating};}
  .dz-cta--solid:active{transform:translateY(0) scale(.985);}
  .dz-cta--ghost{background:${heroGlass.ghostBg};color:${T.ink.inverse};box-shadow:inset 0 0 0 1px ${heroGlass.ghostBorder};}
  .dz-cta--ghost:hover{background:${heroGlass.ghostBgHover};transform:translateY(-2px);}
  .dz-cta--ghost:active{transform:translateY(0) scale(.985);}
  .dz-cta:disabled{opacity:.6;cursor:default;transform:none;box-shadow:${T.shadow.elevated};}
  .dz-cta:focus-visible,.dz-himport:focus-visible{outline:2px solid ${T.ink.inverse};outline-offset:2px;}

  .dz-or{display:flex;align-items:center;gap:${T.space.md}px;margin:${T.space.lg}px 0 ${T.space.md}px;position:relative;}
  .dz-or::before,.dz-or::after{content:"";flex:1;height:1px;background:${heroGlass.divider};}
  .dz-or span{font-size:${T.font.meta}px;font-weight:${T.weight.medium};opacity:.85;white-space:nowrap;}

  .dz-himport{display:flex;align-items:center;justify-content:center;gap:${T.space.sm}px;background:${heroGlass.importBg};border-radius:${T.radius.button}px;padding:11px ${T.space.md}px;color:${T.ink.inverse};font-size:${T.font.body}px;font-weight:${T.weight.semibold};font-family:inherit;border:none;cursor:pointer;box-shadow:inset 0 0 0 1px ${heroGlass.importBorder};transition:background ${tr},transform ${tr};}
  .dz-himport:hover{background:${heroGlass.importBgHover};transform:translateY(-2px);}
  .dz-himport:active{transform:translateY(0);}
  .dz-hlogo{width:26px;height:26px;border-radius:${T.radius.input}px;background:${T.surface.card};display:grid;place-items:center;flex:none;box-shadow:${T.shadow.elevated};}
  .dz-hlogo svg{width:16px;height:16px;}
  .dz-hlogo--gmail svg{width:16px;height:13px;}

  /* ---------------- Stations ---------------- */
  .dz-sec-title{display:flex;align-items:center;gap:${T.space.md}px;font-size:${T.font.meta}px;font-weight:${T.weight.semibold};color:${T.ink.meta};margin:${T.space["2xl"]}px 0 ${T.space.md}px;}
  .dz-sec-title::after{content:"";flex:1;height:1px;background:${T.border.DEFAULT};}
  .dz-stations{display:flex;flex-direction:column;gap:${T.space.sm}px;}
  .dz-station{display:flex;align-items:center;gap:${T.space.lg}px;background:${T.surface.card};border:1px solid ${T.border.DEFAULT};border-radius:${T.radius.card}px;padding:${T.space.md}px ${T.space.lg}px;box-shadow:${T.shadow.elevated};text-align:start;width:100%;color:${T.ink.primary};font:inherit;cursor:pointer;transition:transform ${tr},border-color ${tr},box-shadow ${tr};}
  .dz-station:hover{transform:translateX(-4px);border-color:${T.border.hover};box-shadow:${T.shadow.floating};}
  .dz-station:active{transform:translateX(0);}
  .dz-station:focus-visible{outline:2px solid ${T.brand.mid};outline-offset:2px;}
  .dz-station--attn{border-color:${T.semantic.attention.border};}
  .dz-station__ico{width:42px;height:42px;border-radius:${T.radius.input}px;background:${T.semantic.success.bg};color:${T.brand.mid};display:grid;place-items:center;flex:none;box-shadow:inset 0 0 0 1px ${T.semantic.success.border};}
  .dz-station__ico svg{width:22px;height:22px;}
  .dz-station__tx{flex:1;min-width:0;}
  .dz-station__tx b{font-size:${T.font.body}px;font-weight:${T.weight.semibold};display:block;color:${T.ink.primary};}
  .dz-station__tx small{font-size:${T.font.meta}px;color:${T.ink.muted};}
  .dz-badge{background:${T.semantic.urgent.ink};color:${T.ink.inverse};font-size:${T.font.meta}px;font-weight:${T.weight.semibold};min-width:23px;height:23px;padding:0 7px;border-radius:${T.radius.pill}px;display:grid;place-items:center;flex:none;}
  .dz-chev{color:${T.ink.meta};flex:none;transition:transform ${tr},color ${tr};}
  .dz-station:hover .dz-chev{transform:translateX(-3px);color:${T.brand.mid};}

  /* ---------------- Alerts ---------------- */
  .dz-alert{background:${T.semantic.urgent.bgSoft};border:1px solid ${T.semantic.urgent.border};border-radius:${T.radius.card}px;padding:${T.space.lg}px;box-shadow:${T.shadow.elevated};margin-top:${T.space.md}px;}
  .dz-alert__title{color:${T.semantic.urgent.ink};font-weight:${T.weight.semibold};}
  .dz-alert__text{margin:8px 0 0;color:${T.semantic.urgent.ink};font-size:${T.font.body}px;line-height:1.6;}

  /* ---------------- Responsive ---------------- */
  @media (max-width:560px){
    .dz-docs-home__content{padding-inline:${T.space.lg}px !important;padding-bottom:148px !important;}
  }
  `;
}
