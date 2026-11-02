import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

/**
 * Documents hub — presentation styles for the owner-approved illustrated home
 * (mockup 2026-11-02).
 *
 * The mockup carries its own warm, light palette (cream canvas, sand cards,
 * sage + terracotta accents) that the DS tokens don't express, so it is kept
 * here as ONE scoped set of custom properties on `.dz-dh` — the single source
 * for this screen. Hover / focus / responsive rules can't live inline, so the
 * whole sheet is emitted once by the page.
 *
 * Breakpoints follow the shell (768 / 1024 / 1200). Mobile first: one column,
 * two-up action grid; ≥768 the actions spread to four; ≥1200 the month's
 * document table joins under the hub (the previous desktop capability).
 */

export const hubShellStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#FCFAF5",
  color: "#1D1F1C",
};

export function hubCss(): string {
  const T = TOKEN;
  return `
  .dz-dh{
    --dh-canvas:#FCFAF5;
    --dh-sand:#F5EEE3;
    --dh-ink:#1D1F1C;
    --dh-muted:#6E675D;
    --dh-faint:#958D80;
    --dh-line:#E6DFD3;
    --dh-sage:#5E7C62;
    --dh-sage-soft:#E3E7DB;
    --dh-terra:#D46F4B;
    --dh-terra-soft:#F8DDD1;
    --dh-amber:#FBDDB0;
    --dh-amber-ink:#3E2B10;
    --dh-focus:#5E7C62;
    font-family:var(--font-heebo), Heebo, system-ui, sans-serif;
  }
  .dz-dh *{box-sizing:border-box;}
  .dz-dh__content{
    width:100%;max-width:560px;margin:0 auto;
    padding:12px 16px 148px;
  }

  /* ---------- Header ---------- */
  .dz-dh-top{display:flex;justify-content:flex-start;min-height:44px;align-items:center;}
  .dz-dh-back{
    display:inline-flex;align-items:center;gap:4px;min-height:44px;padding:0 4px;
    background:none;border:0;color:var(--dh-ink);font:inherit;font-size:18px;font-weight:500;cursor:pointer;
    border-radius:12px;
  }
  .dz-dh-back--pending{min-height:44px;}
  .dz-dh-back__chev{display:grid;place-items:center;transform:scaleX(-1);}
  .dz-dh-back__chev svg{width:24px;height:24px;stroke-width:2.4;}
  .dz-dh-back:dir(ltr) .dz-dh-back__chev{transform:none;}
  .dz-dh-title{
    margin:2px 0 18px;text-align:center;
    font-size:40px;line-height:1.1;font-weight:600;letter-spacing:-.5px;color:var(--dh-ink);
  }

  /* ---------- Summary ---------- */
  .dz-dh-summary{
    background:var(--dh-sand);border-radius:16px;padding:16px 16px 14px;
  }
  .dz-dh-summary__title{text-align:center;font-size:16px;font-weight:500;color:var(--dh-ink);}
  .dz-dh-summary__cols{display:flex;align-items:center;margin-top:14px;}
  .dz-dh-summary__sep{width:1px;align-self:stretch;background:var(--dh-line);margin:4px 0;}
  .dz-dh-stat{flex:1;display:flex;align-items:center;justify-content:center;gap:12px;min-width:0;padding:0 6px;}
  .dz-dh-stat__ico{
    width:52px;height:52px;border-radius:50%;flex:none;display:grid;place-items:center;
  }
  .dz-dh-stat__ico svg{width:28px;height:28px;}
  .dz-dh-stat--income .dz-dh-stat__ico{background:var(--dh-sage-soft);color:var(--dh-sage);}
  .dz-dh-stat--expense .dz-dh-stat__ico{background:var(--dh-terra-soft);color:var(--dh-terra);}
  .dz-dh-stat__tx{display:flex;flex-direction:column;align-items:center;min-width:0;}
  .dz-dh-stat__k{font-size:15px;color:var(--dh-muted);}
  .dz-dh-stat__v{
    font-size:clamp(19px, 6vw, 26px);font-weight:600;letter-spacing:-.4px;color:var(--dh-ink);
    font-variant-numeric:tabular-nums;white-space:nowrap;
  }
  .dz-dh-summary__foot{
    margin-top:12px;text-align:center;font-size:13px;color:var(--dh-muted);line-height:1.5;
  }
  .dz-dh-summary__foot b{font-weight:600;color:var(--dh-ink);font-variant-numeric:tabular-nums;}
  .dz-dh-summary__counts{display:none;}
  .dz-dh-delta{margin-inline-start:8px;font-weight:500;white-space:nowrap;}
  .dz-dh-delta--up{color:${T.semantic.success.ink};}
  .dz-dh-delta--down{color:${T.semantic.urgent.ink};}
  .dz-dh-summary--error{text-align:center;}
  .dz-dh-summary__msg{margin:6px 0 0;font-size:14px;color:var(--dh-muted);}
  .dz-dh-retry{
    margin-top:12px;min-height:44px;padding:0 20px;border-radius:14px;border:1px solid var(--dh-line);
    background:#fff;color:var(--dh-ink);font:inherit;font-weight:600;cursor:pointer;
  }

  .dz-dh-shimmer{
    display:block;border-radius:8px;
    background:linear-gradient(90deg,#ECE4D7 0%,#F7F1E8 50%,#ECE4D7 100%);background-size:200% 100%;
    animation:dz-dh-shimmer 1.3s ease-in-out infinite;
  }
  .dz-dh-shimmer--amount{width:110px;height:30px;margin-top:4px;}
  .dz-dh-shimmer--line{width:150px;height:13px;margin:0 auto;}
  @keyframes dz-dh-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}

  /* ---------- Actions ---------- */
  .dz-dh-h2{margin:30px 0 14px;text-align:center;font-size:26px;font-weight:600;color:var(--dh-ink);}
  .dz-dh-actions{display:grid;grid-template-columns:1fr 1fr;gap:18px 12px;}
  .dz-dh-action{
    display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;
    background:none;border:0;padding:4px 2px 8px;border-radius:20px;color:var(--dh-ink);
    font:inherit;cursor:pointer;min-width:0;
    transition:transform .18s ease, background-color .18s ease;
  }
  .dz-dh-action__art{
    width:100%;max-width:180px;height:auto;aspect-ratio:240/190;margin-bottom:6px;
    transition:transform .2s ease;
  }
  .dz-dh-action:hover .dz-dh-action__art{transform:translateY(-3px);}
  .dz-dh-action:active{transform:scale(.98);}
  .dz-dh-action:disabled{cursor:progress;opacity:.55;}
  .dz-dh-action:disabled .dz-dh-action__art{transform:none;}
  .dz-dh-action__title{font-size:21px;font-weight:600;line-height:1.25;}
  .dz-dh-action__sub{font-size:14px;color:var(--dh-muted);line-height:1.4;}
  .dz-dh-pill{
    margin-top:6px;display:inline-flex;align-items:center;min-height:32px;padding:0 16px;border-radius:999px;
    background:var(--dh-amber);color:var(--dh-amber-ink);font-size:15px;font-weight:500;
  }
  .dz-dh-pill--clear{background:var(--dh-sage-soft);color:#3F5A44;}
  .dz-dh-pill--loading{width:132px;background:linear-gradient(90deg,#ECE4D7 0%,#F7F1E8 50%,#ECE4D7 100%);background-size:200% 100%;animation:dz-dh-shimmer 1.3s ease-in-out infinite;}
  .dz-dh-hint{margin:10px 0 0;text-align:center;font-size:12px;color:var(--dh-faint);}

  /* ---------- Channels ---------- */
  .dz-dh-channels{
    display:flex;align-items:stretch;margin-top:18px;
    border-top:1px solid var(--dh-line);border-bottom:1px solid var(--dh-line);
  }
  .dz-dh-channels__sep{width:1px;background:var(--dh-line);margin:14px 0;}
  .dz-dh-channel{
    flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:14px 6px;min-height:72px;
    background:none;border:0;color:var(--dh-ink);font:inherit;text-align:start;cursor:pointer;
  }
  .dz-dh-channel__tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
  .dz-dh-channel__title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;flex-wrap:wrap;}
  .dz-dh-channel__logo{display:inline-grid;place-items:center;}
  .dz-dh-channel__logo svg{width:26px;height:20px;}
  .dz-dh-channel__logo--wa svg{width:24px;height:24px;filter:grayscale(1);opacity:.75;}
  .dz-dh-channel__sub{font-size:13px;color:var(--dh-muted);}
  .dz-dh-channel--off{cursor:default;}
  .dz-dh-channel--off .dz-dh-channel__title{color:var(--dh-muted);font-weight:500;}
  .dz-dh-channel__soon{color:var(--dh-muted);}
  .dz-dh-chev{color:var(--dh-ink);display:grid;place-items:center;flex:none;}
  .dz-dh-chev svg{width:22px;height:22px;}
  .dz-dh-chev:dir(ltr) svg{transform:scaleX(-1);}

  /* ---------- Accountant pack ---------- */
  .dz-dh-pack{
    width:100%;display:flex;align-items:center;gap:14px;margin-top:22px;
    background:var(--dh-sand);border:0;border-radius:18px;padding:12px 16px 12px 14px;
    color:var(--dh-ink);font:inherit;text-align:start;cursor:pointer;
    transition:transform .18s ease, box-shadow .18s ease;
  }
  .dz-dh-pack:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(80,60,30,.08);}
  .dz-dh-pack__art{width:118px;height:auto;aspect-ratio:240/190;flex:none;}
  .dz-dh-pack__tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
  .dz-dh-pack__title{font-size:24px;font-weight:600;}
  .dz-dh-pack__sub{font-size:14px;color:var(--dh-muted);}

  .dz-dh-action:focus-visible,.dz-dh-channel:focus-visible,.dz-dh-pack:focus-visible,
  .dz-dh-back:focus-visible,.dz-dh-retry:focus-visible{outline:3px solid var(--dh-focus);outline-offset:3px;}

  /* ---------- Alerts ---------- */
  .dz-dh-alert{
    margin:14px 0 0;background:${T.semantic.urgent.bgSoft};border:1px solid ${T.semantic.urgent.border};
    border-radius:14px;padding:12px 14px;color:${T.semantic.urgent.ink};font-weight:500;
  }

  @media (max-width:420px){
    .dz-dh-stat{gap:8px;padding:0 4px;}
    .dz-dh-stat__ico{width:42px;height:42px;}
    .dz-dh-stat__ico svg{width:22px;height:22px;}
    .dz-dh-channel__sub{font-size:12px;}
  }

  @media (prefers-reduced-motion:reduce){
    .dz-dh *{animation:none !important;transition:none !important;}
  }

  /* ---------- Medium: four actions in a row ---------- */
  @media (min-width:768px){
    .dz-dh__content{max-width:880px;padding:20px 24px 140px;}
    .dz-dh-title{font-size:44px;}
    .dz-dh-summary{padding:18px 24px 16px;}
    .dz-dh-actions{grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;}
    .dz-dh-summary__counts{display:inline;}
  }

  /* ---------- Expanded: channels + pack side by side ---------- */
  @media (min-width:1024px){
    .dz-dh__content{max-width:1040px;padding:24px 32px 64px;}
    .dz-dh-lower{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:center;margin-top:22px;}
    .dz-dh-lower .dz-dh-channels{margin-top:0;}
    .dz-dh-lower .dz-dh-pack{margin-top:0;}
    .dz-dh-action{padding:12px 8px 14px;}
    .dz-dh-action:hover{background:var(--dh-sand);}
  }

  /* ---------- Month's documents table (desktop capability, unchanged) ---------- */
  .dz-docs-work,.dz-dh-table-h{display:none;}
  @media (min-width:1200px){
    .dz-dh__content{max-width:1200px;}
    .dz-dh-table-h{display:block;margin:34px 0 12px;font-size:20px;font-weight:600;color:var(--dh-ink);}
    .dz-docs-work{
      display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,320px);gap:12px;align-items:start;
    }
    .dz-docs-work,.dz-docs-work > *{min-width:0;}
    .dz-docs-inspector{
      position:sticky;top:16px;background:${T.surface.card};border:1px solid ${T.border.DEFAULT};
      border-radius:${T.radius.card}px;padding:16px;box-shadow:${T.shadow.elevated};
    }
    .dz-docs-inspector h2{margin:0 0 8px;font-size:18px;color:${T.ink.primary};}
    .dz-docs-inspector p{margin:0;color:${T.ink.muted};font-size:${T.font.body}px;line-height:1.5;}
    .dz-docs-inspector dl{margin:12px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:${T.font.body}px;}
    .dz-docs-inspector dt{color:${T.ink.meta};}
    .dz-docs-inspector button{
      margin-top:14px;width:100%;height:44px;border:none;border-radius:${T.radius.button}px;
      background:${T.brand.gradient};color:${T.ink.inverse};font:inherit;font-weight:${T.weight.semibold};cursor:pointer;
    }
    .dz-docs-table{
      display:block;background:${T.surface.card};border:1px solid ${T.border.DEFAULT};
      border-radius:${T.radius.card}px;box-shadow:${T.shadow.elevated};overflow:auto;
    }
    .dz-docs-table table{width:100%;border-collapse:collapse;font-size:${T.font.body}px;}
    .dz-docs-table th{
      text-align:start;font-weight:${T.weight.semibold};color:${T.ink.meta};font-size:${T.font.meta}px;
      padding:12px 14px;border-bottom:1px solid ${T.border.DEFAULT};white-space:nowrap;background:${T.surface.inset};
    }
    .dz-docs-table td{padding:12px 14px;border-bottom:1px solid ${T.border.DEFAULT};color:${T.ink.primary};vertical-align:middle;}
    .dz-docs-table tr:last-child td{border-bottom:none;}
    .dz-docs-table tbody tr{cursor:pointer;}
    .dz-docs-table tbody tr:hover td,.dz-docs-table tr.is-selected td{background:${T.surface.inset};}
    .dz-docs-table .num{font-variant-numeric:tabular-nums;white-space:nowrap;}
    .dz-docs-pill{
      display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:${T.radius.pill}px;
      font-size:${T.font.meta}px;font-weight:${T.weight.semibold};
      background:${T.semantic.attention.bg};color:${T.semantic.attention.ink};
    }
    .dz-docs-pill--ok{background:${T.semantic.success.bg};color:${T.semantic.success.ink};}
    .dz-docs-empty{padding:28px 16px;text-align:center;color:${T.ink.muted};}
  }
  `;
}
