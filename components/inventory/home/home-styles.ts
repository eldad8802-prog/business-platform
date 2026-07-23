import { inventoryHomeCssVars } from "@/components/inventory/inventory-tokens";

/**
 * Inventory HOME (screen s8 modern redesign) stylesheet.
 *
 * Presentation only. The structure/design (teal hero, stock-health bar, 2×2
 * quick actions, attention rows, animations) is the approved
 * `inventory-home-v3-modern` layout — but the CANVAS is the warm DS v1 language,
 * inherited from the module's existing `--inv-*` tokens so the home matches the
 * other inventory sub-screens (items / alerts / count) exactly. The only
 * home-scoped tokens left (`--inv-home-*`, see `inventoryHomeCssVars`) are the
 * brand teal ramp, the four categorical action-icon accents, the skeleton
 * shimmer, radii and easing — surfaces / text / status all resolve to the warm
 * module tokens. Nothing here touches `TOKEN.dsv1` or Documents.
 *
 * Scoped under `[data-inventory-home]`; every class is prefixed `inv-hm-` to
 * avoid collision with the module-wide `inv-*` foundation classes. Heebo +
 * `font-synthesis` capped so DS v1 weight ≤ 600 holds.
 */
export const homeCss = `
[data-inventory-home] {
  ${inventoryHomeCssVars}
  background: var(--inv-page-bg);
  color: var(--inv-text);
  direction: rtl;
  min-height: 100vh;
  min-height: 100dvh;
  font-synthesis: none;
}
[data-inventory-home] .inv-hm-frame {
  max-width: 520px;
  margin: 0 auto;
  /* Own clearance for the fixed shell BottomBar (ShellChrome also reserves
     calc(100px + safe-area) on its scroll container); keeps content above it. */
  padding: 20px 20px calc(96px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
}
[data-inventory-home] *,
[data-inventory-home] *::before,
[data-inventory-home] *::after { box-sizing: border-box; }
[data-inventory-home] button {
  font-family: inherit;
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
}

/* staggered entrance */
@keyframes inv-hm-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
[data-inventory-home] .inv-hm-rise { animation: inv-hm-rise 0.55s var(--inv-home-ease) both; }
@media (prefers-reduced-motion: reduce) {
  [data-inventory-home] .inv-hm-rise { animation: none; }
}

/* header */
[data-inventory-home] .inv-hm-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin: 4px 0 20px;
}
[data-inventory-home] .inv-hm-head h1 {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.4px;
  margin: 0;
}
[data-inventory-home] .inv-hm-greet {
  font-size: 14.5px;
  color: var(--inv-text-muted);
  font-weight: 500;
  margin-top: 3px;
}
[data-inventory-home] .inv-hm-scan {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--inv-home-teal-2);
  color: var(--inv-home-on-teal);
  display: grid;
  place-items: center;
  flex: none;
  box-shadow: var(--inv-shadow-glow);
  transition: transform 0.16s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-scan:hover { transform: translateY(-2px) rotate(-4deg); }
[data-inventory-home] .inv-hm-scan:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-scan svg { width: 24px; height: 24px; }

/* section head */
[data-inventory-home] .inv-hm-sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 26px 2px 13px;
}
[data-inventory-home] .inv-hm-sec h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.2px; margin: 0; }
[data-inventory-home] .inv-hm-sec a { font-size: 13.5px; color: var(--inv-home-teal-2); font-weight: 600; }
[data-inventory-home] .inv-hm-link {
  font-size: 13.5px;
  color: var(--inv-home-teal-2);
  font-weight: 600;
  background: none;
  padding: 0;
}

/* teal hero — brand teal ramp on the warm canvas */
[data-inventory-home] .inv-hm-hero {
  position: relative;
  overflow: hidden;
  border-radius: var(--inv-home-r-card);
  background:
    radial-gradient(120% 100% at 90% -20%, rgba(255, 255, 255, 0.24), transparent 52%),
    linear-gradient(150deg, var(--inv-home-teal-1), var(--inv-home-teal-2) 58%, var(--inv-home-teal-3));
  color: var(--inv-home-on-teal);
  padding: 22px 22px 20px;
  box-shadow: var(--inv-shadow-glow);
}
[data-inventory-home] .inv-hm-hero::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  pointer-events: none;
}
[data-inventory-home] .inv-hm-hero-top { display: flex; align-items: center; justify-content: space-between; position: relative; }
[data-inventory-home] .inv-hm-hero-lbl { font-size: 12.5px; opacity: 0.85; font-weight: 500; }
[data-inventory-home] .inv-hm-hero-big {
  font-size: 38px;
  font-weight: 600;
  letter-spacing: -0.8px;
  line-height: 1.05;
  margin-top: 4px;
  position: relative;
  font-variant-numeric: tabular-nums;
}
[data-inventory-home] .inv-hm-hero-cur { font-size: 20px; opacity: 0.6; margin-inline-start: 2px; }
[data-inventory-home] .inv-hm-hero-foot { font-size: 12.5px; opacity: 0.8; margin-top: 5px; position: relative; }

/* stock-health card */
[data-inventory-home] .inv-hm-health {
  background: var(--inv-card-bg);
  border: 1px solid var(--inv-border);
  border-radius: var(--inv-home-r-card);
  padding: 17px 18px;
  box-shadow: var(--inv-shadow);
  margin-top: 12px;
}
[data-inventory-home] .inv-hm-health-hh { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
[data-inventory-home] .inv-hm-health-hh b { font-size: 14.5px; font-weight: 600; }
[data-inventory-home] .inv-hm-health-hh small { font-size: 12.5px; color: var(--inv-text-muted); }
[data-inventory-home] .inv-hm-hbar { display: flex; gap: 3px; height: 11px; margin-bottom: 14px; }
[data-inventory-home] .inv-hm-hbar i { display: block; border-radius: 4px; transition: flex 0.4s var(--inv-home-ease); }
[data-inventory-home] .inv-hm-hbar .ok { background: linear-gradient(90deg, var(--inv-home-teal-1), var(--inv-home-teal-2)); }
[data-inventory-home] .inv-hm-hbar .low { background: var(--inv-warning); }
[data-inventory-home] .inv-hm-hbar .crit { background: var(--inv-danger); }
[data-inventory-home] .inv-hm-hleg { display: flex; gap: 8px; }
[data-inventory-home] .inv-hm-hleg button {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: flex-start;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--inv-surface-2);
  text-align: start;
  transition: background 0.15s var(--inv-home-ease), transform 0.15s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-hleg button:hover { background: var(--inv-border); transform: translateY(-1px); }
[data-inventory-home] .inv-hm-hleg button:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-hleg .r { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--inv-text-muted); font-weight: 500; }
[data-inventory-home] .inv-hm-hleg .dot { width: 8px; height: 8px; border-radius: 50%; }
[data-inventory-home] .inv-hm-hleg .ok .dot { background: var(--inv-home-teal-2); }
[data-inventory-home] .inv-hm-hleg .low .dot { background: var(--inv-warning); }
[data-inventory-home] .inv-hm-hleg .crit .dot { background: var(--inv-danger); }
[data-inventory-home] .inv-hm-hleg .v { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
[data-inventory-home] .inv-hm-hleg .low .v { color: var(--inv-warning-ink); }
[data-inventory-home] .inv-hm-hleg .crit .v { color: var(--inv-danger); }

/* quick actions */
[data-inventory-home] .inv-hm-qa { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
[data-inventory-home] .inv-hm-qtile {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--inv-card-bg);
  border: 1px solid var(--inv-border);
  border-radius: var(--inv-home-r-card);
  padding: 17px 18px;
  text-align: start;
  box-shadow: var(--inv-shadow);
  transition: transform 0.16s var(--inv-home-ease), box-shadow 0.16s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-qtile:hover { transform: translateY(-3px); box-shadow: var(--inv-shadow-card-hover); }
[data-inventory-home] .inv-hm-qtile:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-qtile .lab { flex: 1; font-size: 15.5px; font-weight: 600; }
[data-inventory-home] .inv-hm-qtile .ci {
  width: 46px;
  height: 46px;
  border-radius: var(--inv-home-r-chip);
  display: grid;
  place-items: center;
  flex: none;
  transition: transform 0.16s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-qtile:hover .ci { transform: scale(1.06); }
[data-inventory-home] .inv-hm-qtile .ci svg { width: 23px; height: 23px; }
[data-inventory-home] .inv-hm-ci--teal { background: var(--inv-home-icon-teal-bg); color: var(--inv-home-icon-teal); }
[data-inventory-home] .inv-hm-ci--blue { background: var(--inv-home-icon-blue-bg); color: var(--inv-home-icon-blue); }
[data-inventory-home] .inv-hm-ci--amber { background: var(--inv-home-icon-amber-bg); color: var(--inv-home-icon-amber); }
[data-inventory-home] .inv-hm-ci--violet { background: var(--inv-home-icon-violet-bg); color: var(--inv-home-icon-violet); }

/* attention rows */
[data-inventory-home] .inv-hm-rows { display: flex; flex-direction: column; gap: 10px; }
[data-inventory-home] .inv-hm-arow {
  display: flex;
  align-items: center;
  gap: 13px;
  background: var(--inv-card-bg);
  border: 1px solid var(--inv-border);
  border-radius: var(--inv-home-r-card);
  padding: 13px 15px;
  text-align: start;
  width: 100%;
  box-shadow: var(--inv-shadow);
  transition: transform 0.16s var(--inv-home-ease), box-shadow 0.16s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-arow:hover { transform: translateY(-3px); box-shadow: var(--inv-shadow-card-hover); }
[data-inventory-home] .inv-hm-arow:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-arow .ci { width: 44px; height: 44px; border-radius: var(--inv-home-r-chip); display: grid; place-items: center; flex: none; }
[data-inventory-home] .inv-hm-arow.crit .ci { background: var(--inv-danger-bg); color: var(--inv-danger); }
[data-inventory-home] .inv-hm-arow.low .ci { background: var(--inv-warning-bg); color: var(--inv-warning-ink); }
[data-inventory-home] .inv-hm-arow .ci svg { width: 22px; height: 22px; }
[data-inventory-home] .inv-hm-arow .nm { flex: 1; min-width: 0; }
[data-inventory-home] .inv-hm-arow .r1 { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
[data-inventory-home] .inv-hm-arow .r1 b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-inventory-home] .inv-hm-arow .q { font-size: 12.5px; font-weight: 600; flex: none; font-variant-numeric: tabular-nums; }
[data-inventory-home] .inv-hm-arow.crit .q { color: var(--inv-danger); }
[data-inventory-home] .inv-hm-arow.low .q { color: var(--inv-warning-ink); }
[data-inventory-home] .inv-hm-arow .pbar { height: 6px; border-radius: 999px; background: var(--inv-surface-2); margin-top: 8px; overflow: hidden; }
[data-inventory-home] .inv-hm-arow .pbar i { display: block; height: 100%; border-radius: 999px; }
[data-inventory-home] .inv-hm-arow.crit .pbar i { background: var(--inv-danger); }
[data-inventory-home] .inv-hm-arow.low .pbar i { background: var(--inv-warning); }

/* calm inline note (ready state, nothing needs attention) */
[data-inventory-home] .inv-hm-note {
  background: var(--inv-card-bg);
  border: 1px solid var(--inv-border);
  border-radius: var(--inv-home-r-card);
  padding: 20px 16px;
  text-align: center;
  color: var(--inv-text-muted);
  font-size: 14px;
  font-weight: 500;
  box-shadow: var(--inv-shadow);
}

/* empty / error state box */
[data-inventory-home] .inv-hm-state {
  background: var(--inv-card-bg);
  border: 1px solid var(--inv-border);
  border-radius: var(--inv-home-r-card);
  padding: 40px 24px;
  text-align: center;
  box-shadow: var(--inv-shadow);
}
[data-inventory-home] .inv-hm-state .ei {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--inv-success-bg);
  color: var(--inv-home-teal-2);
  display: grid;
  place-items: center;
  margin: 0 auto 16px;
}
[data-inventory-home] .inv-hm-state.err .ei { background: var(--inv-danger-bg); color: var(--inv-danger); }
[data-inventory-home] .inv-hm-state .ei svg { width: 28px; height: 28px; }
[data-inventory-home] .inv-hm-state h3 { font-size: 18px; font-weight: 600; margin: 0 0 7px; }
[data-inventory-home] .inv-hm-state p { font-size: 14px; color: var(--inv-text-muted); margin: 0 auto 20px; max-width: 290px; line-height: 1.55; }
[data-inventory-home] .inv-hm-state .cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--inv-home-teal-2);
  color: var(--inv-home-on-teal);
  font-size: 15px;
  font-weight: 600;
  padding: 12px 22px;
  border-radius: 14px;
  box-shadow: var(--inv-shadow-glow);
  transition: transform 0.15s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-state .cta:hover { transform: translateY(-2px); }
[data-inventory-home] .inv-hm-state .cta:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-state .cta svg { width: 19px; height: 19px; }
[data-inventory-home] .inv-hm-state .retry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--inv-home-teal-2);
  padding: 11px 22px;
  background: var(--inv-surface-2);
  border: 1px solid var(--inv-border);
  border-radius: 14px;
  transition: background 0.15s var(--inv-home-ease);
}
[data-inventory-home] .inv-hm-state .retry:hover { background: var(--inv-card-bg); }
[data-inventory-home] .inv-hm-state .retry:focus-visible { outline: 2px solid var(--inv-home-teal-1); outline-offset: 2px; }
[data-inventory-home] .inv-hm-state .retry svg { width: 17px; height: 17px; }

/* skeleton — warm shimmer tokens */
[data-inventory-home] .inv-hm-sk {
  background: linear-gradient(100deg, var(--inv-home-sk-base) 30%, var(--inv-home-sk-hi) 50%, var(--inv-home-sk-base) 70%);
  background-size: 200% 100%;
  animation: inv-hm-sh 1.3s ease-in-out infinite;
  border-radius: 18px;
}
@keyframes inv-hm-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  [data-inventory-home] .inv-hm-sk { animation: none; }
}
`;
