/**
 * Inventory v2 — the approved redesign language (owner-approved mockups, 2026-11-03).
 * Warm cream surfaces, one restrained deep green (the Dubiz brand), Heebo, quiet lines,
 * few frames and shadows, consistent product images. Warning colours only with text.
 * Scoped to [data-inv2] so nothing outside inventory changes.
 */
export const inv2Css = `
[data-inv2] {
  --i2-bg: #faf7f2;
  --i2-card: #fffdf9;
  --i2-beige: #f3ede3;
  --i2-beige-2: #ece4d6;
  --i2-line: #e8e1d5;
  --i2-line-strong: #d9d0c1;
  --i2-ink: #1f2b26;
  --i2-ink-2: #3c4842;
  --i2-muted: #6b716a;
  --i2-green: var(--dz-brand, #246966);
  --i2-green-hover: var(--dz-brand-hover, #1c5451);
  --i2-green-soft: #e3efe9;
  --i2-green-ink: #1e5a4c;
  --i2-danger: #b4462f;
  --i2-danger-soft: #fbe7e1;
  --i2-warn: #8a5a1f;
  --i2-warn-soft: #fbeedc;
  --i2-ok: #1e6a4a;
  --i2-ok-soft: #e5f1e8;
  --i2-info-soft: #f3ede3;
  --i2-radius: 12px;
  --i2-radius-sm: 10px;
  --i2-gutter: 16px;
  --i2-nav-h: 0px;
  font-family: "Heebo", system-ui, sans-serif;
  font-synthesis-weight: none;
  color: var(--i2-ink);
  background: var(--i2-bg);
  min-height: 100vh;
  min-height: 100dvh;
  direction: rtl;
}
[data-inv2] *, [data-inv2] *::before, [data-inv2] *::after { box-sizing: border-box; }
[data-inv2] button { font-family: inherit; }
[data-inv2] :focus-visible { outline: 2px solid var(--i2-green); outline-offset: 2px; border-radius: 8px; }
.i2-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ----- page ----- */
.i2-page { max-width: var(--i2-max, 720px); margin: 0 auto; padding: 0 var(--i2-gutter) calc(var(--i2-nav-h) + 96px); }
.i2-page--wide { --i2-max: 1180px; }
.i2-hd { position: sticky; top: 0; z-index: 5; background: var(--i2-bg); border-bottom: 1px solid var(--i2-line);
  display: grid; grid-template-columns: minmax(84px, 1fr) auto minmax(84px, 1fr); align-items: center; gap: 8px;
  min-height: 60px; margin: 0 calc(-1 * var(--i2-gutter)); padding: 8px var(--i2-gutter); }
.i2-hd__start { justify-self: start; min-width: 0; }
.i2-hd__title { margin: 0; font-size: 21px; font-weight: 600; text-align: center; line-height: 1.25; overflow-wrap: anywhere; }
.i2-hd__end { justify-self: end; display: flex; align-items: center; gap: 4px; }
.i2-back { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 6px; border: 0; background: none;
  color: var(--i2-ink-2); font-size: 15px; font-weight: 500; cursor: pointer; max-width: 160px; }
.i2-back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.i2-back svg { flex: 0 0 auto; }
.i2-iconbtn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 0;
  background: none; color: var(--i2-ink-2); border-radius: 10px; cursor: pointer; }
.i2-textbtn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border: 1px solid var(--i2-line);
  background: var(--i2-beige); border-radius: 10px; color: var(--i2-ink); font-size: 14px; font-weight: 500; cursor: pointer; }

/* ----- section tabs ----- */
.i2-tabs { display: flex; border-bottom: 1px solid var(--i2-line); margin: 4px 0 16px; }
.i2-tab { flex: 1; text-align: center; padding: 12px 4px 10px; font-size: 16px; font-weight: 500; color: var(--i2-muted);
  text-decoration: none; border-bottom: 3px solid transparent; margin-bottom: -1px; min-height: 44px; background: none; border-top: 0; border-inline: 0; cursor: pointer; }
.i2-tab[aria-current="page"], .i2-tab[aria-selected="true"] { color: var(--i2-green-ink); border-bottom-color: var(--i2-green); font-weight: 600; }

/* ----- stats ----- */
.i2-stats { display: grid; grid-template-columns: repeat(3, 1fr); padding: 14px 0 4px; }
.i2-stat { text-align: center; padding: 0 6px; }
.i2-stat + .i2-stat { border-inline-start: 1px solid var(--i2-line); }
.i2-stat__v { font-size: 24px; font-weight: 600; line-height: 1.2; }
.i2-stat__l { font-size: 13.5px; color: var(--i2-muted); margin-top: 2px; }

/* ----- tiles ----- */
.i2-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.i2-tile { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 58px; padding: 10px 16px;
  background: var(--i2-beige); border: 0; border-radius: var(--i2-radius); color: var(--i2-ink); font-size: 16px; font-weight: 500;
  text-decoration: none; cursor: pointer; text-align: start; }
.i2-tile svg { color: var(--i2-ink-2); flex: 0 0 auto; }
.i2-tile:hover { background: var(--i2-beige-2); }

/* ----- headings & text ----- */
.i2-h2 { font-size: 19px; font-weight: 600; margin: 22px 0 8px; }
.i2-h3 { font-size: 16px; font-weight: 600; margin: 18px 0 8px; }
.i2-muted { color: var(--i2-muted); }
.i2-foot { text-align: center; color: var(--i2-muted); font-size: 13.5px; margin: 14px 0 0; }
.i2-num { font-variant-numeric: tabular-nums; }

/* ----- product thumb ----- */
.i2-thumb { position: relative; flex: 0 0 auto; width: var(--s, 56px); height: var(--s, 56px); border-radius: 10px; overflow: hidden;
  background: var(--i2-beige); display: inline-flex; align-items: center; justify-content: center; }
.i2-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.i2-thumb__l { font-size: calc(var(--s, 56px) * 0.42); font-weight: 500; color: var(--i2-ink-2); line-height: 1; }

/* ----- rows ----- */
.i2-list { list-style: none; margin: 0; padding: 0; }
.i2-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--i2-line); min-height: 72px; }
.i2-row:last-child { border-bottom: 0; }
.i2-row__main { flex: 1; min-width: 0; text-decoration: none; color: inherit; display: flex; align-items: center; gap: 12px; }
.i2-row__text { min-width: 0; flex: 1; }
.i2-row__kicker { font-size: 12.5px; color: var(--i2-muted); }
.i2-row__title { font-size: 16.5px; font-weight: 600; line-height: 1.3; display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.i2-row__title > span { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.i2-row__sub { font-size: 14px; color: var(--i2-muted); margin-top: 2px; overflow-wrap: anywhere; }
.i2-clamp2 { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.i2-row__sub--danger { color: var(--i2-danger); }
.i2-row__trail { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.i2-row__qty { text-align: center; min-width: 56px; }
.i2-row__qty b { display: block; font-size: 19px; font-weight: 600; }
.i2-row__qty span { font-size: 13px; color: var(--i2-muted); }
.i2-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--i2-danger); flex: 0 0 auto; display: inline-block; }
.i2-dot--warn { background: #c98a2c; }
.i2-link { color: var(--i2-ink-2); font-size: 14px; text-decoration: none; display: inline-flex; align-items: center; gap: 2px; min-height: 44px; padding: 0 4px; }

/* ----- buttons ----- */
.i2-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 0 18px;
  border-radius: var(--i2-radius-sm); font-size: 17px; font-weight: 600; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
.i2-btn--primary { background: var(--i2-green); color: #fff; }
.i2-btn--primary:hover { background: var(--i2-green-hover); }
.i2-btn--secondary { background: var(--i2-card); color: var(--i2-ink); border-color: var(--i2-line-strong); }
.i2-btn--soft { background: var(--i2-beige); color: var(--i2-ink); }
.i2-btn--danger { background: var(--i2-card); color: var(--i2-danger); border-color: #e6c3b9; }
.i2-btn--sm { min-height: 40px; font-size: 15px; padding: 0 14px; }
.i2-btn--block { width: 100%; }
.i2-btn[disabled], .i2-btn[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
.i2-pill { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; min-width: 76px; padding: 0 14px;
  border-radius: 10px; background: var(--i2-green); color: #fff; font-size: 15px; font-weight: 600; border: 0; cursor: pointer; text-decoration: none; }
.i2-pill--outline { background: var(--i2-card); color: var(--i2-green-ink); border: 1.5px solid var(--i2-green); }
.i2-actions { display: flex; gap: 10px; margin-top: 16px; }
.i2-actions > * { flex: 1; }
.i2-underline { background: none; border: 0; color: var(--i2-green-ink); text-decoration: underline; text-underline-offset: 4px;
  font-size: 15px; font-weight: 500; cursor: pointer; min-height: 44px; padding: 0 6px; }

/* ----- footer (stays above the app's bottom bar + accessibility button) ----- */
.i2-footer { margin-top: 18px; padding: 10px 0 0; }
.i2-footer--dock { position: fixed; left: 0; right: 0; bottom: var(--i2-nav-h); z-index: 40; margin: 0;
  padding: 12px var(--i2-gutter) var(--i2-fab-gap, 64px); background: var(--i2-bg); border-top: 1px solid var(--i2-line); }
.i2-footer--dock > .i2-footer__in { max-width: var(--i2-max, 720px); margin: 0 auto; }
.i2-footer__row { display: flex; align-items: center; gap: 12px; }
.i2-footer__row > .i2-btn { flex: 1; min-width: 0; white-space: nowrap; }
.i2-footer__sum { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--i2-beige);
  border-radius: var(--i2-radius); padding: 10px 14px; margin-bottom: 8px; font-size: 16px; }
.i2-footer__sum b { font-size: 20px; font-weight: 600; }
.i2-footer__note { text-align: center; color: var(--i2-muted); font-size: 13.5px; margin: 6px 0 0; }
@media (min-width: 1200px) { [data-inv2] { --i2-fab-gap: 16px; } }

/* ----- search & chips ----- */
.i2-searchrow { display: flex; gap: 8px; align-items: center; margin: 4px 0 12px; }
.i2-search { flex: 1; display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 14px; background: var(--i2-beige);
  border: 1px solid transparent; border-radius: var(--i2-radius); }
.i2-search:focus-within { border-color: var(--i2-green); background: var(--i2-card); }
.i2-search input { flex: 1; min-width: 0; border: 0; background: none; font: inherit; font-size: 16px; color: var(--i2-ink); outline: none; }
.i2-search input::placeholder { color: var(--i2-muted); }
.i2-scanbtn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 48px; min-height: 48px; padding: 0 12px;
  border: 1.5px solid var(--i2-line-strong); background: var(--i2-card); border-radius: var(--i2-radius); color: var(--i2-ink); cursor: pointer; font-size: 15px; font-weight: 500; }
.i2-scanbtn--wide { border-color: var(--i2-green); color: var(--i2-green-ink); font-size: 16px; }
.i2-chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; }
.i2-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--i2-line);
  background: var(--i2-card); color: var(--i2-ink-2); font-size: 15px; font-weight: 500; cursor: pointer; }
.i2-chip[aria-pressed="true"] { background: var(--i2-green-soft); border-color: #bcd8cd; color: var(--i2-green-ink); font-weight: 600; }
.i2-chip__n { font-size: 13px; color: var(--i2-muted); }

/* ----- notes & status ----- */
.i2-note { display: flex; gap: 10px; align-items: flex-start; background: var(--i2-info-soft); border-radius: var(--i2-radius-sm);
  padding: 12px 14px; font-size: 14.5px; color: var(--i2-ink-2); line-height: 1.45; margin: 12px 0; }
.i2-note svg { flex: 0 0 auto; margin-top: 1px; }
.i2-note--warn { background: var(--i2-warn-soft); color: var(--i2-warn); }
.i2-note--danger { background: var(--i2-danger-soft); color: var(--i2-danger); }
.i2-note--ok { background: var(--i2-ok-soft); color: var(--i2-ok); }
.i2-status { display: inline-flex; align-items: center; min-height: 28px; padding: 2px 12px; border-radius: 999px; font-size: 14px; font-weight: 500;
  background: var(--i2-beige); color: var(--i2-ink-2); white-space: nowrap; }
.i2-status--ok { background: var(--i2-ok-soft); color: var(--i2-ok); }
.i2-status--warn { background: var(--i2-warn-soft); color: var(--i2-warn); }
.i2-status--danger { background: var(--i2-danger-soft); color: var(--i2-danger); }
.i2-status--info { background: #e3eef0; color: #2f5d66; }
.i2-delta { display: inline-flex; align-items: center; justify-content: center; min-width: 52px; min-height: 34px; border-radius: 8px;
  font-weight: 600; font-size: 16px; direction: ltr; }
.i2-delta--up { background: var(--i2-ok-soft); color: var(--i2-ok); }
.i2-delta--down { background: var(--i2-danger-soft); color: var(--i2-danger); }

/* ----- key/value + tables ----- */
.i2-kv { margin: 8px 0 0; border-top: 1px solid var(--i2-line); }
.i2-kv__r { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--i2-line); font-size: 15.5px; }
.i2-kv__r dt { color: var(--i2-ink-2); }
.i2-kv__r dd { margin: 0; font-weight: 500; text-align: end; overflow-wrap: anywhere; }
.i2-table { width: 100%; border-collapse: collapse; font-size: 15px; }
.i2-table th { background: var(--i2-beige); font-weight: 600; text-align: start; padding: 10px 12px; font-size: 14.5px; }
.i2-table th:first-child { border-start-start-radius: 10px; border-end-start-radius: 10px; }
.i2-table th:last-child { border-start-end-radius: 10px; border-end-end-radius: 10px; }
.i2-table td { padding: 10px 12px; border-bottom: 1px solid var(--i2-line); vertical-align: middle; }
.i2-table tr:last-child td { border-bottom: 0; }
.i2-table--box { border: 1px solid var(--i2-line); border-radius: var(--i2-radius); border-collapse: separate; border-spacing: 0; overflow: hidden; }
.i2-cellprod { display: flex; align-items: center; gap: 10px; min-width: 0; }

/* ----- forms ----- */
.i2-field { display: grid; grid-template-columns: minmax(96px, 34%) 1fr; align-items: center; gap: 4px 12px; margin: 10px 0; }
.i2-field--stack { grid-template-columns: 1fr; }
.i2-field__lab { font-size: 15px; color: var(--i2-ink); font-weight: 500; }
.i2-field__opt { color: var(--i2-muted); font-weight: 400; font-size: 13.5px; }
.i2-field__req { color: var(--i2-danger); margin-inline-start: 2px; }
.i2-field__help { grid-column: 2; font-size: 13px; color: var(--i2-muted); margin: 0; }
.i2-field--stack .i2-field__help, .i2-field--stack .i2-field__err { grid-column: 1; }
.i2-field__err { grid-column: 2; font-size: 13.5px; color: var(--i2-danger); margin: 0; }
.i2-input, .i2-select, .i2-textarea { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid var(--i2-line); background: var(--i2-beige);
  border-radius: var(--i2-radius-sm); font: inherit; font-size: 16px; color: var(--i2-ink); }
.i2-input:focus, .i2-select:focus, .i2-textarea:focus { outline: none; border-color: var(--i2-green); background: var(--i2-card); }
.i2-input[aria-invalid="true"] { border-color: var(--i2-danger); background: #fff; }
.i2-textarea { min-height: 84px; resize: vertical; }
.i2-affix { position: relative; }
.i2-affix > span { position: absolute; inset-inline-end: 12px; top: 50%; transform: translateY(-50%); color: var(--i2-muted); pointer-events: none; }
.i2-affix > .i2-input { padding-inline-end: 34px; }
.i2-section { border-top: 1px solid var(--i2-line); padding: 6px 0 4px; }
.i2-section__hd { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 52px; background: none; border: 0;
  font-size: 18px; font-weight: 600; color: var(--i2-ink); cursor: pointer; padding: 0; text-align: start; }
.i2-section__sum { font-size: 13.5px; color: var(--i2-muted); font-weight: 400; display: block; margin-top: -8px; padding-bottom: 8px; }

/* ----- quantity ----- */
.i2-qty { display: inline-flex; align-items: center; gap: 6px; }
.i2-qty__b { width: 44px; height: 44px; border-radius: 10px; border: 0; background: var(--i2-beige); color: var(--i2-ink); font-size: 22px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.i2-qty__b[disabled] { opacity: .35; cursor: not-allowed; }
.i2-qty__in { width: 64px; height: 44px; text-align: center; border: 1px solid var(--i2-line-strong); border-radius: 10px; background: var(--i2-card);
  font: inherit; font-size: 18px; font-weight: 500; color: var(--i2-ink); }
.i2-qty--lg .i2-qty__in { width: auto; flex: 1; min-width: 120px; font-size: 22px; height: 52px; }
.i2-qty--lg { display: flex; }
.i2-qty--lg .i2-qty__b { width: 56px; height: 52px; }
.i2-qty--sm .i2-qty__b { width: 40px; height: 40px; }
.i2-qty--sm .i2-qty__in { width: 52px; height: 40px; font-size: 17px; }

/* ----- segmented ----- */
.i2-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--i2-beige); border-radius: var(--i2-radius-sm); padding: 3px; }
.i2-seg button { min-height: 44px; border: 0; background: none; border-radius: 8px; font-size: 15.5px; font-weight: 500; color: var(--i2-ink-2); cursor: pointer; }
.i2-seg button[aria-pressed="true"] { background: var(--i2-green); color: #fff; font-weight: 600; }

/* ----- wizard steps ----- */
.i2-steps { display: flex; align-items: flex-start; justify-content: center; gap: 0; margin: 12px 0 16px; list-style: none; padding: 0; }
.i2-steps li { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 14px; color: var(--i2-muted); min-width: 64px; position: relative; flex: 1; }
.i2-steps li::before { content: ""; position: absolute; top: 16px; inset-inline-start: 50%; width: 100%; height: 2px; background: var(--i2-line-strong); z-index: 0; }
.i2-steps li:last-child::before { display: none; }
.i2-steps__dot { position: relative; z-index: 1; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: var(--i2-beige-2); color: var(--i2-ink-2); font-weight: 600; font-size: 15px; }
.i2-steps li[data-state="current"] { color: var(--i2-ink); font-weight: 600; }
.i2-steps li[data-state="current"] .i2-steps__dot { background: var(--i2-green); color: #fff; }
.i2-steps li[data-state="done"] .i2-steps__dot { background: var(--i2-green); color: #fff; }

/* ----- radio rows ----- */
.i2-radio { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--i2-line); border-radius: var(--i2-radius);
  background: var(--i2-card); cursor: pointer; margin: 8px 0; min-height: 56px; }
.i2-radio input { width: 22px; height: 22px; accent-color: var(--i2-green); flex: 0 0 auto; margin: 0; }
.i2-radio:has(input:checked) { background: var(--i2-green-soft); border-color: #bcd8cd; }
.i2-radio--plain { border: 0; background: none; padding: 6px 4px; margin: 2px 0; min-height: 44px; }

/* ----- cards / boxes ----- */
.i2-box { background: var(--i2-beige); border-radius: var(--i2-radius); padding: 12px 14px; }
.i2-card { background: var(--i2-card); border: 1px solid var(--i2-line); border-radius: var(--i2-radius); padding: 12px 14px; }
.i2-split { display: grid; grid-template-columns: 1fr 1fr; }
.i2-split > div { text-align: center; padding: 4px 8px; }
.i2-split > div + div { border-inline-start: 1px solid var(--i2-line-strong); }
.i2-split small { display: block; color: var(--i2-muted); font-size: 13.5px; }
.i2-split b { font-size: 19px; font-weight: 600; }

/* ----- states ----- */
.i2-state { text-align: center; padding: 36px 12px; color: var(--i2-ink-2); }
.i2-state__t { font-size: 18px; font-weight: 600; color: var(--i2-ink); margin: 0 0 6px; }
.i2-state__b { font-size: 15px; color: var(--i2-muted); margin: 0 0 16px; }
.i2-skel { background: linear-gradient(90deg, var(--i2-beige) 0%, var(--i2-beige-2) 50%, var(--i2-beige) 100%); background-size: 200% 100%;
  animation: i2sh 1.2s linear infinite; border-radius: 10px; }
@keyframes i2sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .i2-skel { animation: none; } }

/* ----- sheet & modal (portaled to body) ----- */
.i2-scrim { position: fixed; inset: 0; background: rgba(31, 43, 38, .38); z-index: 200; }
.i2-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 201; margin: 0 auto; max-width: 560px; background: var(--i2-card);
  border-radius: 22px 22px 0 0; padding: 8px 18px calc(18px + env(safe-area-inset-bottom, 0px)); max-height: 92vh; overflow-y: auto;
  box-shadow: 0 -8px 30px rgba(31, 43, 38, .12); }
.i2-sheet__grab { display: block; width: 44px; height: 5px; border-radius: 3px; background: var(--i2-line-strong); margin: 4px auto 10px; border: 0; }
.i2-sheet__hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.i2-sheet__hd h2 { margin: 0; font-size: 21px; font-weight: 600; }
.i2-modal { position: fixed; z-index: 201; inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(92vw, 420px); background: var(--i2-card);
  border-radius: 18px; padding: 20px; box-shadow: 0 12px 40px rgba(31, 43, 38, .18); }
.i2-modal h2 { margin: 0 0 8px; font-size: 19px; font-weight: 600; }
.i2-modal p { margin: 0; color: var(--i2-ink-2); font-size: 15px; line-height: 1.5; }

/* ----- menu ----- */
.i2-menu { position: relative; }
.i2-menu__pop { position: absolute; inset-inline-end: 0; top: calc(100% + 4px); min-width: 210px; background: var(--i2-card); border: 1px solid var(--i2-line);
  border-radius: 12px; box-shadow: 0 10px 30px rgba(31, 43, 38, .14); padding: 6px; z-index: 30; }
.i2-menu__item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 0 12px; border: 0; background: none; border-radius: 8px;
  font-size: 15px; color: var(--i2-ink); text-decoration: none; cursor: pointer; text-align: start; }
.i2-menu__item:hover { background: var(--i2-beige); }

/* ----- small generic parts (products area) ----- */
.i2-tiles.i2-tiles--3 { grid-template-columns: repeat(3, 1fr); }
.i2-tile--stack { flex-direction: column; justify-content: center; text-align: center; gap: 4px; min-height: 76px; padding: 10px 6px; font-size: 15px; }
.i2-line { display: block; }
.i2-line--danger { color: var(--i2-danger); }
.i2-split--arrow { grid-template-columns: 1fr auto 1fr; align-items: center; }
.i2-split__arrow { color: var(--i2-muted); display: inline-flex; }
.i2-hero { position: relative; display: flex; gap: 14px; align-items: flex-start; padding: 6px 0 4px; }
.i2-hero__text { flex: 1; min-width: 0; }
.i2-hero__name { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.i2-hero__meta { margin: 4px 0 8px; color: var(--i2-muted); font-size: 15px; overflow-wrap: anywhere; }
.i2-hero__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.i2-hero__chips .i2-status { white-space: normal; }
.i2-imgpick { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin: 6px 0 4px; }
.i2-imgpick__thumb { position: relative; }
.i2-imgpick__x { position: absolute; top: -10px; inset-inline-end: -10px; width: 44px; height: 44px; border-radius: 50%; border: 0;
  background: none; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
.i2-imgpick__x > span { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--i2-line-strong); background: var(--i2-card); color: var(--i2-ink);
  display: inline-flex; align-items: center; justify-content: center; }
.i2-imgpick__tile { position: relative; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; width: 124px; height: 96px;
  border: 1.5px dashed var(--i2-line-strong); border-radius: var(--i2-radius); background: var(--i2-beige); color: var(--i2-ink-2); font-size: 14.5px; font-weight: 500; cursor: pointer; }
.i2-imgpick__tile:focus-within { outline: 2px solid var(--i2-green); outline-offset: 2px; }
.i2-imgpick__tile input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.i2-check { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15.5px; cursor: pointer; margin: 6px 0; }
.i2-check input { width: 22px; height: 22px; accent-color: var(--i2-green); margin: 0; flex: 0 0 auto; }
.i2-hdlink { display: none; color: var(--i2-ink-2); font-size: 14px; text-decoration: none; white-space: nowrap; min-height: 44px; align-items: center; padding: 0 2px; }
@media (min-width: 440px) { .i2-hdlink { display: inline-flex; } }
.i2-desk-only { display: none; }
.i2-table tbody tr[data-href] { cursor: pointer; }
.i2-table tbody tr[data-href]:hover td { background: var(--i2-beige); }
@media (min-width: 1200px) {
  .i2-desk-only { display: block; }
  .i2-mob-only { display: none; }
}

/* ----- responsive ----- */
@media (max-width: 359px) {
  [data-inv2] { --i2-gutter: 12px; }
  .i2-hd { grid-template-columns: minmax(64px, 1fr) auto minmax(64px, 1fr); }
  .i2-hd__title { font-size: 19px; }
  .i2-field { grid-template-columns: 1fr; }
  .i2-field__help, .i2-field__err { grid-column: 1; }
  .i2-tile { font-size: 15px; padding: 10px 12px; }
}
@media (min-width: 768px) {
  .i2-hd__title { font-size: 23px; }
  .i2-tiles { grid-template-columns: repeat(4, 1fr); }
}
@media (min-width: 1200px) {
  .i2-page { padding-bottom: 48px; }
  .i2-desk { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
  .i2-desk__side { position: sticky; top: 76px; }
}
`;
